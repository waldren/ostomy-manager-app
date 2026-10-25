/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The P4.S6 staging/Cognito spike (#168). Proves two things and nothing more:
 * the API's OIDC claim mapping works against real Cognito with no code
 * change, and the container runs under Fargate's health-check semantics. It is
 * NOT staging: single-AZ, the smallest classes, no NAT, no WAF, no backups
 * worth the name, and it is destroyed after the run.
 *
 * Synthetic data only, like every non-production environment (CLAUDE.md):
 * the stack is tagged `data-classification: synthetic-only` and nothing here
 * may ever hold a real patient's data. `docs/deployment-staging-spike.md` is
 * the runbook.
 *
 * The images are props so the assertion tests can synthesise the stack
 * without building them; `bin/app.ts` passes the real ones.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface SpikeStackProps extends StackProps {
  /** infra/docker/api.Dockerfile's `runtime-aws` target. */
  readonly apiImage: ecs.ContainerImage;
  /** infra/docker/api.Dockerfile's `migrate-aws` target. */
  readonly migrateImage: ecs.ContainerImage;
  /**
   * The commit the images were built from (#76). Required: the API refuses
   * to start with an empty `BUILD_COMMIT`, and the image's own default is
   * empty, so an unset value here is a service that never becomes healthy.
   * (`/api/v1/health` reports it only in development; elsewhere it is for
   * whoever reads the task definition.)
   */
  readonly buildCommit: string;
  /**
   * The API service's task count. Defaults to 0, and the first deploy must
   * use 0: the database has no owner, no `ostomy` database and no runtime
   * role until the two one-off tasks have run, so an API task cannot start.
   * CloudFormation waits for the service to stabilise, and with 1 the circuit
   * breaker fails the create and rolls back the whole stack, database
   * included. Deploy, run the tasks, then deploy again with 1.
   */
  readonly apiDesiredCount?: number;
}

export const DB_NAME = 'ostomy';
export const DB_MASTER_USER = 'ostomy_master';
/** The migration owner (ADR-0011 Amendment 1): CREATEROLE, CREATEDB, not a superuser. */
export const DB_OWNER_ROLE = 'ostomy_owner';
/** Created by the first migration; never a role this stack creates. */
export const DB_RUNTIME_ROLE = 'ostomy_runtime';
/** Where the `-aws` image targets put the RDS CA bundle. */
export const RDS_CA_BUNDLE = '/opt/rds-ca/global-bundle.pem';
export const API_PORT = 3000;
export const HEALTH_PATH = '/api/v1/health';

export class SpikeStack extends Stack {
  constructor(scope: Construct, id: string, props: SpikeStackProps) {
    super(scope, id, props);
    if (props.buildCommit.trim() === '') throw new Error('buildCommit must not be empty');

    Tags.of(this).add('project', 'ostomy');
    Tags.of(this).add('purpose', 'p4-s6-staging-cognito-spike');
    Tags.of(this).add('data-classification', 'synthetic-only');

    // ---- Network ----------------------------------------------------------
    // No NAT gateway: it would be most of the stack's hourly cost. The API
    // tasks sit in public subnets with a public IP for outbound traffic (ECR,
    // Cognito's JWKS, Secrets Manager), and their security group admits only
    // the load balancer. The database and the load balancer are in isolated
    // subnets with no route to the internet at all.
    //
    // `restrictDefaultSecurityGroup` is off because it is implemented as a
    // Lambda-backed custom resource whose log group outlives `cdk destroy`.
    // Nothing is ever placed in the default security group.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Internal ALB: reachable only from inside the VPC (CloudFront VPC origin)',
      allowAllOutbound: false,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      'CloudFront VPC origin; the ALB is internal, so nothing outside the VPC reaches it',
    );
    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      description: 'API tasks: inbound from the ALB only',
    });
    const dbTaskSecurityGroup = new ec2.SecurityGroup(this, 'DbTaskSecurityGroup', {
      vpc,
      description: 'One-off database tasks: no inbound',
    });
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'RDS: inbound from the API and the one-off database tasks only',
      allowAllOutbound: false,
    });
    dbSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(5432), 'API');
    dbSecurityGroup.addIngressRule(dbTaskSecurityGroup, ec2.Port.tcp(5432), 'database tasks');

    // ---- Secrets ----------------------------------------------------------
    // No punctuation in the two passwords that end up inside a connection
    // URL, so they never need percent-encoding in a shell.
    const urlSafePassword = (id: string, description: string) =>
      new secretsmanager.Secret(this, id, {
        description,
        generateSecretString: { excludePunctuation: true, passwordLength: 40 },
        removalPolicy: RemovalPolicy.DESTROY,
      });
    const ownerPassword = urlSafePassword('DbOwnerPassword', `${DB_OWNER_ROLE} (migration owner)`);
    const runtimePassword = urlSafePassword('DbRuntimePassword', `${DB_RUNTIME_ROLE} (API)`);

    // ---- Database ---------------------------------------------------------
    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_17,
    });
    const parameterGroup = new rds.ParameterGroup(this, 'DbParameters', {
      engine,
      parameters: {
        'rds.force_ssl': '1',
        // The Compose stack's `log_error_verbosity=terse`, for the reason
        // docs/deployment-development.md gives: a constraint violation's
        // DETAIL line prints the offending row's values, which are clinical
        // values once real data exists. Terse drops DETAIL.
        log_error_verbosity: 'terse',
        // Pinned rather than left to the engine defaults they equal, so
        // turning one on is a reviewable diff. A logged statement would carry
        // `ALTER ROLE ... PASSWORD` if the tasks sent cleartext (they send a
        // SCRAM verifier), and a bound parameter is a clinical value.
        log_statement: 'none',
        log_min_duration_statement: '-1',
        log_parameter_max_length: '0',
        log_parameter_max_length_on_error: '0',
      },
    });
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret(DB_MASTER_USER),
      parameterGroup,
      multiAz: false,
      publiclyAccessible: false,
      storageEncrypted: true,
      allocatedStorage: 20,
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const masterSecret = database.secret;
    if (masterSecret === undefined) throw new Error('the master secret is generated');

    // ---- Identity ---------------------------------------------------------
    // Two pools, disjoint by construction (SRS §4.6, ADR-0008): different
    // issuers, different JWKS, different clients. Each app client is public
    // (no secret) with OAuth disabled, so no client_credentials grant exists:
    // a machine token carries `client_id` and `token_use: access` too, and
    // would otherwise pass the guard (#169 review). USER_PASSWORD_AUTH is on
    // only so the runbook can mint a token from the CLI; the real clients
    // use authorization code + PKCE, which is P9's to configure.
    //
    // SPIKE-ONLY, each a blocker before real patients: MFA is off (SRS §4.6
    // makes it mandatory for every admin account), account recovery is NONE
    // (there is no reset flow yet), USER_PASSWORD_AUTH is enabled, and
    // threat protection and deletion protection are off.
    //
    // The issuer is spelled out rather than taken from `userPoolProviderUrl`,
    // so its form (scheme included, no trailing slash) is visible here and
    // asserted by a test: the API refuses to boot on a malformed issuer.
    const identity = (id: string, name: string) => {
      const pool = new cognito.UserPool(this, `${id}Pool`, {
        userPoolName: `ostomy-spike-${name}`,
        selfSignUpEnabled: false,
        signInAliases: { username: true },
        mfa: cognito.Mfa.OFF,
        passwordPolicy: { minLength: 14 },
        accountRecovery: cognito.AccountRecovery.NONE,
        deletionProtection: false,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const client = pool.addClient(`${id}Client`, {
        userPoolClientName: `ostomy-spike-${name}`,
        generateSecret: false,
        disableOAuth: true,
        authFlows: { userPassword: true },
        preventUserExistenceErrors: true,
        accessTokenValidity: Duration.minutes(60),
        idTokenValidity: Duration.minutes(60),
        refreshTokenValidity: Duration.days(1),
      });
      const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`;
      return { pool, client, issuer };
    };
    const patient = identity('Patient', 'patient');
    const admin = identity('Admin', 'admin');

    // ---- Containers -------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const runtimePlatform = {
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };
    const dbHost = database.dbInstanceEndpointAddress;

    // The settings slice 1 (#169) added: Cognito's access token names its
    // client in `client_id`, and only `token_use: access` is a credential.
    const oidc = (prefix: string, pool: ReturnType<typeof identity>) => ({
      [`${prefix}OIDC_ISSUER`]: pool.issuer,
      [`${prefix}OIDC_JWKS_URI`]: `${pool.issuer}/.well-known/jwks.json`,
      [`${prefix}OIDC_AUDIENCE`]: pool.client.userPoolClientId,
      [`${prefix}OIDC_SUBJECT_CLAIM`]: 'sub',
      [`${prefix}OIDC_AUDIENCE_CLAIM`]: 'client_id',
      [`${prefix}OIDC_REQUIRED_TOKEN_USE`]: 'access',
    });

    const apiTask = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform,
    });
    apiTask.addContainer('api', {
      image: props.apiImage,
      // The runtime role's DSN is assembled in the container from the secret,
      // so the password is never in the task definition. verify-full against
      // the RDS CA bundle: `pg` reads `require` as verify-full anyway, and
      // Node does not trust the RDS CA on its own.
      entryPoint: ['sh', '-c'],
      command: [
        `export DATABASE_URL="postgresql://${DB_RUNTIME_ROLE}:$DB_RUNTIME_PASSWORD@$DB_HOST:5432/${DB_NAME}?sslmode=verify-full&sslrootcert=${RDS_CA_BUNDLE}" && exec node dist/main.js`,
      ],
      environment: {
        NODE_ENV: 'production',
        PORT: String(API_PORT),
        LOG_LEVEL: 'info',
        BUILD_COMMIT: props.buildCommit,
        DB_HOST: dbHost,
        CORS_ALLOWED_ORIGINS: '',
        ...oidc('', patient),
        ...oidc('ADMIN_', admin),
        // Nothing uses object storage yet, and on Fargate credentials come
        // from the task role, which the config cannot express: it requires
        // static keys. Placeholders until P5's photo work (#168 finding 4).
        OBJECT_STORAGE_ENDPOINT: `https://s3.${this.region}.amazonaws.com`,
        OBJECT_STORAGE_REGION: this.region,
        OBJECT_STORAGE_ACCESS_KEY_ID: 'unused-p4s6-spike',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 'unused-p4s6-spike',
        OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
      },
      secrets: { DB_RUNTIME_PASSWORD: ecs.Secret.fromSecretsManager(runtimePassword) },
      portMappings: [{ containerPort: API_PORT }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
      // An init process as PID 1, so SIGTERM from a task stop reaches node
      // rather than being ignored by a PID 1 with no handler (exit criterion 6).
      linuxParameters: new ecs.LinuxParameters(this, 'ApiLinux', { initProcessEnabled: true }),
      stopTimeout: Duration.seconds(30),
      // The image's own HEALTHCHECK, restated: ECS ignores Dockerfile ones.
      healthCheck: {
        command: [
          'CMD',
          'node',
          '-e',
          `fetch('http://localhost:${API_PORT}${HEALTH_PATH}').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`,
        ],
        interval: Duration.seconds(10),
        timeout: Duration.seconds(3),
        startPeriod: Duration.seconds(15),
        retries: 5,
      },
    });

    const service = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: props.apiDesiredCount ?? 0,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [apiSecurityGroup],
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
    });

    // One-off tasks, run by hand from the runbook (`aws ecs run-task`).
    const oneOff = (id: string, container: ecs.ContainerDefinitionOptions) => {
      const task = new ecs.FargateTaskDefinition(this, id, {
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform,
      });
      task.addContainer('task', container);
      return task;
    };
    const dbEnvironment = {
      DB_HOST: dbHost,
      DB_NAME,
      DB_OWNER_ROLE,
      DB_SSL_CA_FILE: RDS_CA_BUNDLE,
    };
    // As the master user: create the owner and, as the owner, its database.
    const bootstrapTask = oneOff('DbBootstrapTask', {
      image: props.migrateImage,
      command: ['node', 'aws-tasks/db-bootstrap.cjs'],
      environment: { ...dbEnvironment, DB_MASTER_USER },
      secrets: {
        DB_MASTER_PASSWORD: ecs.Secret.fromSecretsManager(masterSecret, 'password'),
        DB_OWNER_PASSWORD: ecs.Secret.fromSecretsManager(ownerPassword),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'db-bootstrap' }),
    });
    // As the owner: the migrations, then the runtime role's password. The
    // migration URL's TLS parameters are Prisma's schema engine's, not
    // libpq's: `sslcert` is the CA to trust, `sslaccept=strict` verifies it.
    const migrateTask = oneOff('DbMigrateTask', {
      image: props.migrateImage,
      entryPoint: ['sh', '-c'],
      command: [
        `export MIGRATION_DATABASE_URL="postgresql://${DB_OWNER_ROLE}:$DB_OWNER_PASSWORD@$DB_HOST:5432/${DB_NAME}?sslmode=require&sslcert=${RDS_CA_BUNDLE}&sslaccept=strict" && node node_modules/prisma/build/index.js migrate deploy && exec node aws-tasks/runtime-password.cjs`,
      ],
      environment: { ...dbEnvironment, DB_RUNTIME_ROLE },
      secrets: {
        DB_OWNER_PASSWORD: ecs.Secret.fromSecretsManager(ownerPassword),
        DB_RUNTIME_PASSWORD: ecs.Secret.fromSecretsManager(runtimePassword),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'db-migrate' }),
    });

    // ---- Load balancer and TLS --------------------------------------------
    // The ALB is INTERNAL. CloudFront reaches it through a VPC origin, over
    // AWS's network, so the ALB has no public address to protect and no
    // CloudFront IP list to maintain. Its security group admits the VPC's CIDR
    // rather than the VPC origin's own security group, which CloudFront
    // creates only after the origin exists and so cannot be named here. The
    // hops behind CloudFront (to the ALB, and the ALB to the task) are plain
    // HTTP inside the VPC: fine for synthetic data, a blocker before PHI. TLS terminates at CloudFront on its
    // default *.cloudfront.net certificate: the spike owns no domain.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSecurityGroup,
    });
    const listener = alb.addListener('Http', { port: 80, open: false });
    listener.addTargets('Api', {
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: HEALTH_PATH,
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // No caching: every API response carries `Cache-Control: no-store`
    // (#152), which CloudFront honours. The Authorization header has to be
    // in a cache policy to reach the origin at all, and a policy may name a
    // header only when its max TTL is above zero, hence 1 second that the
    // no-store header then overrides.
    const cachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'ostomy P4.S6 spike: synthetic data only',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.VpcOrigin.withApplicationLoadBalancer(alb, {
          httpPort: 80,
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });

    // ---- What the runbook needs -------------------------------------------
    const output = (id: string, value: string) => new CfnOutput(this, id, { value });
    output('ApiUrl', `https://${distribution.distributionDomainName}`);
    output('ClusterName', cluster.clusterName);
    output('ServiceName', service.serviceName);
    output('DbBootstrapTaskDefinition', bootstrapTask.taskDefinitionArn);
    output('DbMigrateTaskDefinition', migrateTask.taskDefinitionArn);
    output('TaskSubnetIds', vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','));
    output('DbTaskSecurityGroupId', dbTaskSecurityGroup.securityGroupId);
    output('LogGroupName', logGroup.logGroupName);
    output('PatientUserPoolId', patient.pool.userPoolId);
    output('PatientClientId', patient.client.userPoolClientId);
    output('AdminUserPoolId', admin.pool.userPoolId);
    output('AdminClientId', admin.client.userPoolClientId);
  }
}
