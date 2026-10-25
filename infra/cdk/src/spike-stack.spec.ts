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

// P4.S6 (#168), exit criterion 3: the properties of the spike stack that
// matter, held by assertions on the synthesised template so they cannot drift
// while nothing is deployed. Each block names the property; the template is
// read as JSON where a property spans resources.
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { beforeAll, describe, expect, it } from 'vitest';

import { API_PORT, HEALTH_PATH, RDS_CA_BUNDLE, SpikeStack } from './spike-stack';

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

let template: Template;
let resources: Record<string, Resource>;

beforeAll(() => {
  const app = new App();
  const stack = new SpikeStack(app, 'Spike', { ...images, buildCommit: 'abc123' });
  template = Template.fromStack(stack);
  resources = (template.toJSON() as { Resources: Record<string, Resource> }).Resources;
});

function ofType(type: string): [string, Resource][] {
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

function only(type: string): [string, Resource] {
  const found = ofType(type);
  expect(found).toHaveLength(1);
  return found[0] as [string, Resource];
}

const images = {
  apiImage: ecs.ContainerImage.fromRegistry('example.invalid/api:test'),
  migrateImage: ecs.ContainerImage.fromRegistry('example.invalid/migrate:test'),
};

/** The logical id a `{ Ref }` or `{ Fn::GetAtt }` points at, if it is one. */
function referenced(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.Ref === 'string') return record.Ref;
  const getAtt = record['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
  return undefined;
}

/** Every logical id referenced anywhere inside `value`. */
function referencesIn(value: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    const id = referenced(node);
    if (id !== undefined) found.add(id);
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) Object.values(node).forEach(walk);
  };
  walk(value);
  return found;
}

/**
 * A string value as text, with each `{ Ref }` written `${id}`: a plain
 * string as is, an `Fn::Join` joined. Anything else is a test failure.
 */
function rendered(value: unknown): string {
  if (typeof value === 'string') return value;
  const id = referenced(value);
  if (id !== undefined) return `\${${id}}`;
  const join = (value as Record<string, unknown> | null)?.['Fn::Join'];
  if (Array.isArray(join) && typeof join[0] === 'string' && Array.isArray(join[1])) {
    return (join[1] as unknown[]).map(rendered).join(join[0]);
  }
  throw new Error(`cannot render ${JSON.stringify(value)}`);
}

function taskOf(taskLogicalIdPrefix: string): Resource {
  const found = ofType('AWS::ECS::TaskDefinition').filter(([id]) =>
    id.startsWith(taskLogicalIdPrefix),
  );
  expect(found, `task definition ${taskLogicalIdPrefix}*`).toHaveLength(1);
  return (found[0] as [string, Resource])[1];
}

function containerOf(taskLogicalIdPrefix: string): Record<string, unknown> {
  const task = taskOf(taskLogicalIdPrefix);
  const containers = task.Properties?.ContainerDefinitions as Record<string, unknown>[];
  expect(containers).toHaveLength(1);
  return containers[0] as Record<string, unknown>;
}

function environmentOf(container: Record<string, unknown>): Record<string, unknown> {
  const entries = container.Environment as { Name: string; Value: unknown }[];
  return Object.fromEntries(entries.map((entry) => [entry.Name, entry.Value]));
}

/** The routes in the route table `subnet` is associated with. */
function routesOf(subnet: string): [string, Resource][] {
  const association = ofType('AWS::EC2::SubnetRouteTableAssociation').find(([, candidate]) =>
    referencesIn(candidate.Properties?.SubnetId).has(subnet),
  );
  expect(association, `route table association for ${subnet}`).toBeDefined();
  const routeTable = referenced(association?.[1].Properties?.RouteTableId);
  return ofType('AWS::EC2::Route').filter(
    ([, route]) => referenced(route.Properties?.RouteTableId) === routeTable,
  );
}

function logicalIdStartingWith(type: string, prefix: string): string {
  const match = ofType(type).find(([id]) => id.startsWith(prefix));
  expect(match, `${type} ${prefix}*`).toBeDefined();
  return (match as [string, Resource])[0];
}

describe('the database is never public', () => {
  it('is not publicly accessible, is encrypted, and is PostgreSQL 17', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^17'),
      DBInstanceClass: 'db.t4g.micro',
      MultiAZ: false,
    });
  });

  it('sits in the isolated subnets, which have no route to the internet', () => {
    const [, subnetGroup] = only('AWS::RDS::DBSubnetGroup');
    const subnets = [...referencesIn(subnetGroup.Properties?.SubnetIds)];
    expect(subnets.length).toBeGreaterThan(0);
    for (const subnet of subnets) {
      expect(subnet).toMatch(/isolated/i);
      expect(resources[subnet]?.Properties?.MapPublicIpOnLaunch).toBe(false);
      expect(routesOf(subnet), `routes for ${subnet}`).toHaveLength(0);
    }
  });

  it('admits only the API and the one-off database tasks, by security group', () => {
    const dbGroup = logicalIdStartingWith('AWS::EC2::SecurityGroup', 'DbSecurityGroup');
    const ingress = ofType('AWS::EC2::SecurityGroupIngress')
      .map(([, rule]) => rule.Properties ?? {})
      .filter((rule) => referenced(rule.GroupId) === dbGroup);
    const sources = ingress.map((rule) => referenced(rule.SourceSecurityGroupId));
    expect(sources.sort()).toEqual(
      [
        logicalIdStartingWith('AWS::EC2::SecurityGroup', 'ApiSecurityGroup'),
        logicalIdStartingWith('AWS::EC2::SecurityGroup', 'DbTaskSecurityGroup'),
      ].sort(),
    );
    for (const rule of ingress) expect(rule.FromPort).toBe(5432);
    expect(resources[dbGroup]?.Properties?.SecurityGroupIngress).toBeUndefined();
  });

  it('forces TLS, and keeps row values and statements out of its log', () => {
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: {
        'rds.force_ssl': '1',
        log_error_verbosity: 'terse',
        log_statement: 'none',
        log_min_duration_statement: '-1',
        log_parameter_max_length: '0',
        log_parameter_max_length_on_error: '0',
      },
    });
  });
});

describe('the load balancer is reachable only through CloudFront', () => {
  it('is internal, in the isolated subnets', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
    const [, alb] = only('AWS::ElasticLoadBalancingV2::LoadBalancer');
    const subnets = referencesIn(alb.Properties?.Subnets);
    expect(subnets.size).toBeGreaterThan(0);
    for (const subnet of subnets) {
      expect(subnet).toMatch(/isolated/i);
      expect(routesOf(subnet), `routes for ${subnet}`).toHaveLength(0);
    }
  });

  it('opens nothing to the internet, anywhere in the stack', () => {
    const rules = [
      ...ofType('AWS::EC2::SecurityGroup').flatMap(
        ([, group]) => (group.Properties?.SecurityGroupIngress as unknown[] | undefined) ?? [],
      ),
      ...ofType('AWS::EC2::SecurityGroupIngress').map(([, rule]) => rule.Properties),
    ] as Record<string, unknown>[];
    for (const rule of rules) {
      expect(rule.CidrIp).not.toBe('0.0.0.0/0');
      expect(rule.CidrIpv6).not.toBe('::/0');
    }
  });

  it('admits the VPC on port 80 and nothing else; the API admits only the ALB', () => {
    const albGroup = logicalIdStartingWith('AWS::EC2::SecurityGroup', 'AlbSecurityGroup');
    const albIngress = resources[albGroup]?.Properties?.SecurityGroupIngress as Record<
      string,
      unknown
    >[];
    expect(albIngress).toHaveLength(1);
    expect(albIngress[0]).toMatchObject({ FromPort: 80, ToPort: 80, IpProtocol: 'tcp' });
    expect(referenced(albIngress[0]?.CidrIp)).toMatch(/^Vpc/);

    const apiGroup = logicalIdStartingWith('AWS::EC2::SecurityGroup', 'ApiSecurityGroup');
    const apiIngress = ofType('AWS::EC2::SecurityGroupIngress')
      .map(([, rule]) => rule.Properties ?? {})
      .filter((rule) => referenced(rule.GroupId) === apiGroup);
    expect(apiIngress.map((rule) => referenced(rule.SourceSecurityGroupId))).toEqual([albGroup]);
    expect(apiIngress[0]).toMatchObject({ FromPort: API_PORT, ToPort: API_PORT });
    expect(resources[apiGroup]?.Properties?.SecurityGroupIngress).toBeUndefined();
  });

  it('is CloudFront’s VPC origin, and CloudFront serves HTTPS only', () => {
    const [, vpcOrigin] = only('AWS::CloudFront::VpcOrigin');
    const albId = only('AWS::ElasticLoadBalancingV2::LoadBalancer')[0];
    expect(referencesIn(vpcOrigin.Properties).has(albId)).toBe(true);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'https-only' }),
        Origins: [Match.objectLike({ VpcOriginConfig: Match.anyValue() })],
      }),
    });
  });

  it('forwards the Authorization header, and caches nothing the API marks no-store', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 0,
        MinTTL: 0,
        MaxTTL: 1,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Authorization'] },
        }),
      }),
    });
  });

  it('health-checks the API on its liveness route', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: HEALTH_PATH,
      Port: API_PORT,
      Matcher: { HttpCode: '200' },
    });
  });
});

describe('the token settings (#169) for both pools', () => {
  it('reads the client from client_id and accepts only access tokens, in each pool separately', () => {
    const env = environmentOf(containerOf('ApiTask'));
    for (const prefix of ['', 'ADMIN_']) {
      expect(env[`${prefix}OIDC_AUDIENCE_CLAIM`]).toBe('client_id');
      expect(env[`${prefix}OIDC_REQUIRED_TOKEN_USE`]).toBe('access');
      expect(env[`${prefix}OIDC_SUBJECT_CLAIM`]).toBe('sub');
    }
  });

  it('points each pool at its own Cognito user pool and client: disjoint by construction', () => {
    const env = environmentOf(containerOf('ApiTask'));
    const patientPool = logicalIdStartingWith('AWS::Cognito::UserPool', 'PatientPool');
    const adminPool = logicalIdStartingWith('AWS::Cognito::UserPool', 'AdminPool');
    // The exact form: the API refuses to boot on an issuer that is not a URL,
    // and the `iss` comparison is exact, so a trailing slash rejects every token.
    for (const [prefix, pool] of [
      ['', patientPool],
      ['ADMIN_', adminPool],
    ] as const) {
      const issuer = `https://cognito-idp.\${AWS::Region}.amazonaws.com/\${${pool}}`;
      expect(rendered(env[`${prefix}OIDC_ISSUER`])).toBe(issuer);
      expect(rendered(env[`${prefix}OIDC_JWKS_URI`])).toBe(`${issuer}/.well-known/jwks.json`);
    }
    expect(referenced(env.OIDC_AUDIENCE)).toMatch(/^PatientPoolPatientClient/);
    expect(referenced(env.ADMIN_OIDC_AUDIENCE)).toMatch(/^AdminPoolAdminClient/);
  });

  it('gives no client a secret or an OAuth flow, so no client_credentials token can exist', () => {
    const clients = ofType('AWS::Cognito::UserPoolClient');
    expect(clients).toHaveLength(2);
    for (const [, client] of clients) {
      expect(client.Properties?.GenerateSecret).toBe(false);
      expect(client.Properties?.AllowedOAuthFlows).toBeUndefined();
      expect(client.Properties?.AllowedOAuthFlowsUserPoolClient).toBe(false);
    }
  });

  it('lets no one sign themselves up', () => {
    const pools = ofType('AWS::Cognito::UserPool');
    expect(pools).toHaveLength(2);
    for (const [, pool] of pools) {
      expect(pool.Properties?.AdminCreateUserConfig).toMatchObject({
        AllowAdminCreateUserOnly: true,
      });
    }
  });
});

describe('the API container', () => {
  it('receives only the runtime role’s password, and no DSN with a password in it', () => {
    const container = containerOf('ApiTask');
    const secrets = container.Secrets as { Name: string }[];
    expect(secrets.map((secret) => secret.Name)).toEqual(['DB_RUNTIME_PASSWORD']);
    const env = environmentOf(container);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MIGRATION_DATABASE_URL).toBeUndefined();
    expect(JSON.stringify(container.Command)).toContain('ostomy_runtime:$DB_RUNTIME_PASSWORD@');
    expect(JSON.stringify(container.Command)).toContain('sslmode=verify-full');
  });

  // The API refuses to start with an empty BUILD_COMMIT, found by running
  // the image (#168): the stack used to default it to ''.
  it('is stamped with the commit, never an empty one', () => {
    expect(environmentOf(containerOf('ApiTask')).BUILD_COMMIT).toBe('abc123');
    expect(() => new SpikeStack(new App(), 'Empty', { ...images, buildCommit: ' ' })).toThrow(
      /buildCommit/,
    );
  });

  it('runs an init process, so SIGTERM reaches node', () => {
    expect(containerOf('ApiTask').LinuxParameters).toMatchObject({ InitProcessEnabled: true });
  });

  it('sends no task definition a DB_TLS setting: TLS is never off in AWS', () => {
    for (const task of ['ApiTask', 'DbBootstrapTask', 'DbMigrateTask']) {
      expect(environmentOf(containerOf(task)).DB_TLS, task).toBeUndefined();
    }
  });
});

describe('the one-off database tasks', () => {
  it('verify the server against the RDS CA bundle, in both drivers', () => {
    for (const task of ['DbBootstrapTask', 'DbMigrateTask']) {
      expect(environmentOf(containerOf(task)).DB_SSL_CA_FILE, task).toBe(RDS_CA_BUNDLE);
    }
    // Prisma's schema engine: `sslcert` is the CA, `sslaccept=strict` verifies it.
    const command = JSON.stringify(containerOf('DbMigrateTask').Command);
    expect(command).toContain(`sslcert=${RDS_CA_BUNDLE}&sslaccept=strict`);
    expect(command).not.toContain('accept_invalid_certs');
  });
});

describe('least privilege', () => {
  /** Every secret a role's policies name; the master secret is an attachment. */
  function secretsReadBy(role: string): string[] {
    const secretTypes = [
      'AWS::SecretsManager::Secret',
      'AWS::SecretsManager::SecretTargetAttachment',
    ];
    return [
      ...new Set(
        ofType('AWS::IAM::Policy')
          .filter(([, policy]) => referencesIn(policy.Properties?.Roles).has(role))
          .flatMap(([, policy]) => [...referencesIn(policy.Properties?.PolicyDocument)])
          .filter((id) => secretTypes.includes(resources[id]?.Type ?? '')),
      ),
    ].sort();
  }
  const secret = (prefix: string) => logicalIdStartingWith('AWS::SecretsManager::Secret', prefix);

  it('lets each task’s execution role read exactly the secrets its container is given', () => {
    const master = logicalIdStartingWith(
      'AWS::SecretsManager::SecretTargetAttachment',
      'DatabaseSecretAttachment',
    );
    const expected: Record<string, string[]> = {
      ApiTask: [secret('DbRuntimePassword')],
      DbBootstrapTask: [master, secret('DbOwnerPassword')],
      DbMigrateTask: [secret('DbOwnerPassword'), secret('DbRuntimePassword')],
    };
    for (const [task, secrets] of Object.entries(expected)) {
      const role = referenced(taskOf(task).Properties?.ExecutionRoleArn) as string;
      expect(secretsReadBy(role), task).toEqual([...secrets].sort());
    }
  });

  // The task role is what the running process holds. A grant here would let
  // the API fetch the master password itself (ADR-0011).
  it('gives no task role any policy at all', () => {
    for (const task of ['ApiTask', 'DbBootstrapTask', 'DbMigrateTask']) {
      const role = referenced(taskOf(task).Properties?.TaskRoleArn) as string;
      expect(role, task).toBeDefined();
      const attached = ofType('AWS::IAM::Policy').filter(([, policy]) =>
        referencesIn(policy.Properties?.Roles).has(role),
      );
      expect(attached, task).toHaveLength(0);
      expect(resources[role]?.Properties?.ManagedPolicyArns, task).toBeUndefined();
      expect(resources[role]?.Properties?.Policies, task).toBeUndefined();
    }
  });
});

// The first deploy must start with no API task: the database has no roles
// until the one-off tasks run, and CloudFormation waiting on a service that
// cannot stabilise rolls back the whole stack, database included.
describe('the API service', () => {
  it('starts with no task unless asked for one', () => {
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
    const scaled = Template.fromStack(
      new SpikeStack(new App(), 'Scaled', { ...images, buildCommit: 'abc123', apiDesiredCount: 1 }),
    );
    scaled.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });
});

describe('logs', () => {
  it('keeps every log group for a week, and every container logs to one', () => {
    const groups = ofType('AWS::Logs::LogGroup');
    expect(groups.length).toBeGreaterThan(0);
    for (const [, group] of groups) expect(group.Properties?.RetentionInDays).toBe(7);
    for (const [, task] of ofType('AWS::ECS::TaskDefinition')) {
      for (const container of task.Properties?.ContainerDefinitions as Record<string, unknown>[]) {
        expect(container.LogConfiguration).toMatchObject({ LogDriver: 'awslogs' });
      }
    }
  });
});

describe('teardown removes everything', () => {
  // Exactly Delete on everything that holds state: an RDS instance with no
  // DeletionPolicy at all is snapshotted on delete, and the snapshot outlives
  // the stack.
  it('deletes every stateful resource outright', () => {
    const stateful = [
      'AWS::RDS::DBInstance',
      'AWS::SecretsManager::Secret',
      'AWS::Cognito::UserPool',
      'AWS::Logs::LogGroup',
    ];
    for (const type of stateful) {
      const found = ofType(type);
      expect(found.length, type).toBeGreaterThan(0);
      for (const [id, resource] of found) {
        expect(resource.DeletionPolicy, id).toBe('Delete');
        expect(resource.UpdateReplacePolicy, id).toBe('Delete');
      }
    }
  });

  it('retains and snapshots nothing', () => {
    for (const [id, resource] of Object.entries(resources)) {
      expect(['Retain', 'Snapshot', 'RetainExceptOnCreate'], id).not.toContain(
        resource.DeletionPolicy,
      );
      expect(['Retain', 'Snapshot'], id).not.toContain(resource.UpdateReplacePolicy);
    }
  });

  it('has no deletion protection on the database or the user pools', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: false,
      DeleteAutomatedBackups: true,
    });
    for (const [, pool] of ofType('AWS::Cognito::UserPool')) {
      expect(pool.Properties?.DeletionProtection).toBe('INACTIVE');
    }
  });

  // A Lambda writes its own log group, outside the stack, which survives
  // `cdk destroy` and is the usual residue of a custom resource.
  it('creates no Lambda function', () => {
    expect(ofType('AWS::Lambda::Function')).toHaveLength(0);
  });
});

describe('synthetic data only', () => {
  it('tags the database and the user pools as such', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Tags: Match.arrayWith([{ Key: 'data-classification', Value: 'synthetic-only' }]),
    });
    for (const [, pool] of ofType('AWS::Cognito::UserPool')) {
      expect(pool.Properties?.UserPoolTags).toMatchObject({
        'data-classification': 'synthetic-only',
      });
    }
  });
});
