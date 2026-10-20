# AI Models connection UI

This change builds on PR #155 (`2df0ebd`) and retains the Agent Core Worker architecture merged in PR #115. Native Model Config remains the only configuration authority. Retired model-resource writes remain HTTP 410.

## Implemented release scope

This is the PRD's API-first/P0 phase. The Subscription tab explicitly reports that authorization is unavailable; the server advertises `subscription: false`. No OAuth buttons, mock sessions, or guessed account/plan information are exposed. P1 (real OAuth, refresh/revocation, credential materialization and authenticated inference acceptance) is not implemented or claimed as complete.

- The home view filters the native catalog by `configured`, independently of credential resolution or model availability. Explicit provider configuration, credential references (including missing credentials) and keyless declarations count as configured. Untouched runtime registry entries are connection candidates only.
- Provider rows start collapsed and expand independently. Search matches configured provider names/IDs and model names/IDs. Service and model pagination bounds the rendered list.
- Existing credentials are managed only through each provider's accessible menu. Connection details, custom connection editing, candidate refresh and disconnect use the same menu and backend capability declarations. No legacy enable/disable operation is exposed.
- The connection dialog reuses the existing Modal, with a 600×620 frame bounded by viewport minus 32px. Tabs and footer stay outside the internally scrolling body. API and Subscription have separate contents. Custom API remains above provider search results.
- Builtin API credentials use the native credential PUT. Custom API supports the three native protocols, managed keys, environment references and explicit keyless authentication. Creation validates before atomically saving provider and credential metadata. Discovery candidates require explicit selection; manual IDs work without discovery.
- Custom editing preserves unedited provider fields and metadata on retained models. Removed model overrides are removed with the model. Candidate refresh uses the current stored configuration and server-held credential, returns no credential, and does not write configuration or claim verified inference.
- All writes capture an opening revision. HTTP 409 refreshes the server projection, retains the draft, and never automatically replays a secret-bearing write. Reopen the dialog to work from the new revision. Secrets are cleared on successful save or confirmed discard and are not persisted in browser storage.
- Unsaved changes require explicit discard when closing or switching connection steps. Nested modal keyboard events do not close the outer Settings dialog. Credential dialogs restore focus to the provider menu trigger.

## API additions

`ProviderConfigView.configured` expresses explicit configuration, rather than resolved authentication. The catalog includes `source`, `auth_capabilities` and `allowed_actions`; capabilities come from the compiled runtime provider and the server's implemented adapters. The compatibility provider view also includes the explicit configured flag.

`POST /api/model-config/providers` additionally accepts `{ source: "environment", environment_variable }` as its optional credential. It uses the same reserved-variable rules, copy-on-write storage and rollback behavior as credential replacement.

`POST /api/model-config/providers/:id/discover` accepts an empty object and discovers candidates for an existing authenticated custom connection. It uses the existing outbound request policy and discovery rate limit, resolves credentials on the server and returns `{ models, inference_verified: false }`. It makes no configuration writes. New environment-based connections use manual IDs until they are saved, after which this endpoint can discover their models.

Disconnect uses native provider DELETE with revision protection. It removes native configuration and its credential mapping/keyless declaration. Shared credential objects, legacy resources, historical sessions and model IDs remain governed by the existing native semantics.

## Validation

Unit/integration coverage checks explicit vs untouched providers, broken credentials, server-reported capabilities, environment creation consumed by Worker registries, reserved-variable rejection, revision-protected disconnect, stored-credential discovery without persistence, menu-only management, draft isolation, conflict preservation, metadata-preserving editing and nested Escape behavior.

`pnpm --filter frontend test:uat:model-config` runs against the built real server and Chromium. It checks native authority, atomic Keyless creation, EnvRef redaction, default-model ownership, desktop frame invariance across tabs/forms, responsive bounds, footer containment, keyboard tabs/focus/discard and modal accessibility in light/dark/mobile. Set `MODEL_UAT_SCREENSHOTS` to an absolute directory to retain screenshots.

The visual Settings performance fixture uses the new native catalog fields and menu controls, preserving the 100-provider/10,000-model regression case. Standard typechecks, production build, lint, bundle budget and backend/frontend suites remain applicable.
