# Security & HIPAA Practices (Developer Guide)

Developer-facing practices for handling PHI and meeting the HIPAA requirements in the SRS.

## From the SRS (design-specs/requirements/)
- Encryption of PHI at rest and in transit (TLS 1.3+)
- OAuth 2.0 / OpenID Connect authentication, with biometric login support on mobile
- Automated session timeouts
- Business Associate Agreements (BAAs) required with any cloud providers used

## Developer practices
_TBD — secrets management, local dev data handling (no real PHI in dev/test), dependency review, logging rules (never log PHI), incident response basics._

See also `design-specs/compliance/` for the product/compliance-level documentation.
