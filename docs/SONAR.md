# Sonar analysis for events

Project: `ima-jin_events2`, organization: `ima-jin`.

## One analysis path

The preferred mode is **CI analysis**, using `.github/workflows/sonarcloud.yml`
and the LCOV report produced by `CI`. SonarCloud rejects a CI scan when
Automatic Analysis is also enabled. Automatic Analysis does not consume the
CI coverage report.

A project administrator must open **Administration > Analysis Method** in
SonarCloud and turn **Automatic Analysis off**. Keep the repository/organization
`SONAR_TOKEN` secret configured for CI. Do not change quality profiles, rules,
or the quality gate to solve an analysis-mode conflict.

The workflow reads the public project's `sonar.autoscan.enabled` setting
before scanning. While it is `true`, the CI scanner is skipped with a notice
and Automatic Analysis remains the only analysis path. This is a temporary
fallback, not coverage-consuming CI verification. Once an administrator turns
it off, the existing CI scanner runs without another repository edit.
An unavailable API or an absent/invalid setting fails the mode job rather than
silently passing an unknown mode. Making the project private would require an
authenticated settings query.

As of 2026-10-14, the public API reported Automatic Analysis enabled. The
implementation environment had no Sonar credential or authenticated admin
session, so it did **not** change that external setting.

## PR revision and privileged workflow boundary

Unprivileged `CI` packages source, coverage, and `.sonar-pr-meta.json`.
The privileged `workflow_run` job only downloads that artifact; it does not
check out or execute PR-authored code. Its PR scanner explicitly passes
`sonar.scm.revision` from the metadata's validated 40-character `headSha`.
Do not use the `workflow_run` run's own GitHub SHA as proof of the PR revision:
GitHub associates that run with the default branch.

Changes to the `workflow_run` workflow take effect from the default branch,
not from the open PR's workflow file. Before this change merges, a successful
PR `CI` run can still trigger the old duplicate scanner. The administrator
toggle can remove that blocker immediately.

## Exact-head verification

Get the current head with `gh pr view NUMBER -R ima-jin/events --json headRefOid`.
Wait for every CI job, the Sonar analysis, and the gate on that exact head.
For this public project, these read-only Sonar Web API endpoints need no token:

- `GET /api/issues/search` with `componentKeys=ima-jin_events2`,
  `pullRequest=NUMBER`, `resolved=false`, `ps=1`: require `total` to equal `0`.
- `GET /api/qualitygates/project_status` with `projectKey=ima-jin_events2`,
  `pullRequest=NUMBER`: require `projectStatus.status` to equal `OK`.
- `GET /api/project_pull_requests/list` with `project=ima-jin_events2`:
  select the matching `pullRequests[].key`, require `commit.sha` to equal
  GitHub's `headRefOid`, and record `analysisDate`.
- `GET /api/components/show` with `component=ima-jin_events2`,
  `pullRequest=NUMBER`: correlate `component.analysisDate` with the PR entry's
  `analysisDate`, and check the Sonar GitHub check-run on that exact head.
  Do not send `pullRequest` to `project_analyses/search` or `ce/component`:
  those endpoints do not support it and can return another branch's analysis.

Use the Sonar server URL through `SONAR_HOST_URL` in shell commands and pass
query values with `curl --get --data-urlencode`. If authentication becomes
necessary, consume `SONAR_TOKEN` through an environment variable; never print
its value, enable shell tracing, or paste it into commands/logs.
An `OK` gate alone does not prove total-zero issues or the correct revision.
Keep the PR draft until CI is green and all three conditions are satisfied.
