# Business task follow-through

Scoped by plugin config `agents` (a list of agent ids); without it, the original
`main` and `rendio-taxanalyst` scope applies. This plugin adds a durable command owner,
not a tax writer, task replay engine, or replacement coordinator. No dependencies.

Alerts go back to the requester: each task records the Telegram chat it came from
(helper and dashboard sessions inherit the chat of the session that spawned them), and
its stalled/blocked/failed/done alert is sent there through that agent's own bot. Only
a task with no Telegram origin falls back to `notificationTarget` through the default
(Thor) bot. Helper tasks (spawned by another session) never alert a person: their
outcome reaches the spawning session through the native announce chain. Host-injected
`<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` blocks are stripped before a goal is stored or shown. Every owned agent needs the two tools in its effective tool policy; the
global `tools.alsoAllow` covers agents without their own `alsoAllow` list.

## Ownership

A fresh external command or host-proven delegated assignment enrolls through
`before_prompt_build`. Native spawn currently omits provenance; that path requires
matching current session identity and a business `spawnedBy` entry. Ordinary direct
Telegram turns omit provenance: these enroll only when the host user trigger,
Telegram channel, authenticated sender/chat IDs, direct session ID, and live
session delivery route/account all agree. Explicit internal provenance is never
upgraded to external, and prompt text is never an identity source. Completion
messages do not create tasks. Internal status/approval turns retain the original
command. Real approval must be evaluated by its original owner; no timer grants it.

`business_task_checkpoint` records progress, a native dependency wait, a real
approval wait, or a terminal blocked/failed/canceled outcome. Successful turn end
is never semantic completion. An incomplete ended turn or expired progress lease
is recoverable `stalled`: alert once, retain ownership, accept later progress.
A missing/replaced original owner is explicitly blocked; business writes are not
replayed. Native stop cutoffs suppress effects and canceled tasks never resurrect.

## Completion and delivery

`done` submits `review_pending`, not done. The workspace-contained, SHA-256-bound
JSON receipt must contain schema `business-task-completion/1`, the exact taskId,
`canonicalLandingVerified: true`, `endToEndVerified: true`, nonempty
`canonicalLocation` and `canonicalRevision`, matching integer `expectedCount` and
`observedCount`, and `remainingActions: []`. A plan/test receipt is insufficient.
A different current main/Tax Analyst session must independently inspect those
claims and invoke `business_task_review`. Its approval enters `delivery_pending`;
only an observed native send receipt records final done. The engine validates the
receipt contract, not the truth of arbitrary reviewer attestations.

## Dependency continuation

Codex `spawn_agent` children are not UUID OpenClaw run IDs. Use
`wait_native_result` with the exact returned native child labels (`nativeChildren`)
before yielding for that path. This retains the owned task without pretending the
labels were verified run identities: the existing Codex native completion service
owns child custody, deduplication and foreground/detached parent resumption. The
plugin never sends a synthetic continuation for this state. Missing returns remain
visible through the existing lease/stall path, and late genuine results can progress
the same retained task. No child label grants business-action authorization.

The service checks exact registered native run IDs. Complete prerequisites plus a
message-paused sibling detect the reproduced frozen-batch circular wait. It admits
one idempotent native `sessions.send` to the same original dashboard/subagent
owner, after fresh identity, turn-liveness and cancellation checks. Admission is
not completion. Direct chats retain their owned wait while the existing native child-announcement
path resumes their original owner; readiness alone is not a blocked outcome. If
that return fails to arrive, the normal lease exposes a recoverable stall. No
person chat injection, new coordinator, cohort rewrite, direct
registry mutation, library operation, or blind replay is permitted. An uncertain
continuation stalls for controlling-operator reconciliation, without duplicates.

Existing work is never scanned or inferred authorized. Operator-only Gateway
method `business-task-follow-through.adopt` enrolls one expressly authorized
original wait using sessionKey, expectedSessionId, originalMessageId,
originalStartedAt (epoch milliseconds), goal, and exact existing runIds. It checks
current identity and native cancellation. Recheck the owner immediately before
using it: historical paused owners may already have completed.

## State and alerts

OpenClaw's worker-backed keyed SQLite store owns state across turns/restarts.
The service sweeps every 60 seconds. Classified, changed progress summaries are
reported at most every five minutes through a separate durable outbox. Unchanged
summaries, helper work, approval waits and canceled tasks do not generate progress
messages. This is checkpoint evidence, not a timer's claim that work is progressing.
Incident and progress outbox state is durable before send.
Retries are limited to three pre-admission unavailable checks. A send with an
uncertain receipt is not blindly repeated: service health/logs require operator
reconciliation. This preserves at-most-one dispatch per incident, not a promise
of exactly-once external delivery under transport ambiguity. No automatic retry
of tax/business writes. An explicit new stalled incident after genuine progress
may alert again; an unchanged stale task does not nag.

## Adoption and rollback

Not activated merely by importing or inspecting this directory. Configuration
requires approved `notificationTarget`; conversation hooks require explicit
`hooks.allowConversationAccess: true` for external installations. Both tools need
effective admission in the main/Tax Analyst tool policy. Background Gateway
requests/session facts require host-recognized bundled or trusted-official origin;
ordinary linked-plugin installation does not grant that authority. Do not forge
trust metadata or silently fall back to another transport.

For the authorized custom host, the controlling owner reviews the sealed source
and generated bounded bundled-artifact install before activation. Use the native
safe-config writer and targeted plugin reload, never hand-edit live configuration
or patch core bundles. Verify active registry, service health, actual task tools,
and real delivery/continuation after reload. Disable only this plugin to roll
back; preserve its durable state/receipts and current exact runtime rollback.
The custom-package maintainer must include this source in the next package;
updating to a package without it removes availability and must be detected.

## Qualification

`node --test follow-through.test.mjs` exercises state and protocol negatives.
`FOLLOW_THROUGH_NATIVE_STORE_SDK=file:///.../src/plugin-sdk/plugin-state-test-runtime.ts`
uses the real worker-backed store with the host TS loader. Gateway effects in
these tests are doubles, never live-notification proof. Installed-host inspection
and actual isolated hook/tool invocation are separate evidence from active
Gateway/Telegram and original Tax Analyst acceptance. Parent Thor owns independent
live review and Chase-facing delivery.
