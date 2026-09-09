# Office service boundary

Local Firebase environment for #184, prerequisite of #176. Authentication,
invitations, membership and presence UI are not implemented. The bootstrap
Firestore rules deny every client read/write; they are not production policy.

See [the architecture](../../docs/office/architecture.md). Add functions only
when a trusted operation cannot be safely implemented with reviewed rules and
client contracts. Never place local TMT database or process access here.

## Start locally

Docker is the only required emulator dependency. Java 21, Node 22 and Firebase
CLI 15.29.0 run in the image, without host login credentials or application data.
From the repository root:

```sh
docker compose -f services/office/compose.yaml up --build
```

Auth is available at `127.0.0.1:9099`, Firestore at `127.0.0.1:8080`. The container
binds its internal interfaces; Compose publishes only host loopback. Do not run
this Firebase config directly on the host or expose its ports publicly. Emulator
UI is disabled. Stop with Ctrl-C, then remove the stopped development container:

```sh
docker compose -f services/office/compose.yaml down
```

State is ephemeral: there are no mounted data volumes or automatic imports.
Do not mount credentials, host config or repository roots into this service.
The first image build downloads tools and emulator binaries; later runs use the
cached image. Rebuild deliberately to update pinned tools, not on every test.

## Verify without cloud access

```sh
docker build -f services/office/Dockerfile -t tmt-office-emulators:local .
docker run --rm --init --network none tmt-office-emulators:local \
  firebase emulators:exec --only auth,firestore --project demo-tmt-office \
  --config firebase.json --non-interactive 'node verify-office-emulators.mjs'
```

The Firebase runner waits for readiness and shuts emulators down after the
script, propagating failure. The proof uses actual Auth creation/lookup/deletion,
Firestore privileged fixture write/read/deletion and denied authenticated and
unauthenticated client requests. It is not Office membership/invitation coverage
or a browser E2E test. The privileged `owner` fixture token is emulator-only.
The verifier refuses non-loopback endpoints and any non-demo project.

## Owner-local project settings

The shared configuration never selects a real project. If needed, copy
`.firebaserc.example` to `.firebaserc` in this directory and replace the owner
alias locally. There is deliberately no `default` real-project alias. Cloud CLI
operations must select an explicit project and require separate authorization.
The development container neither copies nor mounts this file.

`.firebaserc`, `.env`/`.env.*` (except `.env.example`), `.firebase/`,
`.firebase-local/`, `.secrets/` and conventional service-account/private-key files
are excluded from Git and Docker contexts. Store any deliberate local emulator
export under `.firebase-local/`; never export production data for these tests.
These patterns are defense in depth, not a secret detector. Review staged content
before committing; never force-add credentials. Safe templates must contain only
placeholders. Never put a private key, refresh token or Admin credential in a
`VITE_*` variable: frontend values become part of the downloadable bundle.

Firebase CLI login stays in its own host credential store. Do not copy or inspect
those credentials to configure this repo. A project ID is an identifier, not a
credential; successful project listing does not authorize deployments, service
enablement, billing changes or database-location selection.

References: [Firebase CLI](https://firebase.google.com/docs/cli),
[emulator setup](https://firebase.google.com/docs/emulator-suite/install_and_configure),
[demo project isolation](https://firebase.google.com/docs/emulator-suite/connect_firestore).
