# Threat model and current limits

Enforced boundaries: selected tab/origin allowlist, cloud/local endpoint validation, no redirects or fallback, one writer, explicit exact-batch approval, document/element/field freshness checks, source-quote validation, session-only keys, typed tool allowlist, no remote execution, no privileged webpage message listener.

Threats tested: out-of-scope AI requests, malformed tools, fabricated evidence, CSV formulas, cancellation races, duplicate approval, storage failure before writes, uncertain-write recovery, stale field values, seeded password and hidden-field disclosure.

Residual risks:
- Page text can contain prompt injection. Instructions and tool boundaries reduce authority but do not solve semantic manipulation.
- Visible page text can contain sensitive information beyond the filters. Users control disclosure to the chosen AI.
- Input/change handlers may autosave or trigger effects. No generic exactly-once or rollback claim is made.
- DOM changes can race execution. A failed batch may have partially applied; it becomes outcome_unknown and is never retried.
- Source text matching proves a quotation exists, not its truth or full task correctness.
- Immediate field equality does not prove the server saved anything.
- Local software, browser compromise and other extensions are outside the credential protection guarantee.
- No benchmark proves provider reliability, universal website support or comprehensive accessibility.

Never test real payments, unapproved messages or destructive account changes. Use controlled pages and reversible fixture data.
