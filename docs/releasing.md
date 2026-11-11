# Releasing

The twelve published packages (`PUBLISHED` in `tools/notices.ts`: `swf2es`
and the `@swf2es/*` packages under `packages/`, and the desktop app,
`@swf2es/desktop`, under `apps/`) are released together, at one version. A page or project that takes several of them takes
them at the same version, and the `workspace:*` ranges between them become
that exact version when pnpm packs them.

Before 1.0 a minor release (0.1 → 0.2) may break a page, and a patch release
(0.1.0 → 0.1.1) may not.

## A release

1. Work through `dev` as usual. Then set the version there:

   ```sh
   node tools/version.ts 0.1.1        # every package.json; 0.2.0-beta.1 for a prerelease
   ```

   Commit the change and merge it, then sync `main` through a `release/*` branch.

2. Tag `main` and push the tag:

   ```sh
   git tag v0.1.1 origin/main
   git push origin v0.1.1
   ```

   The tag starts `.github/workflows/release.yml`. It checks that the tag is
   on `main` and that the tag names the packages' version. It then builds,
   runs the packaging test (`tests/packages/run.ts`) and runs
   `tools/publish.ts`. That script packs each package and publishes it after
   the packages it depends on. A prerelease goes to the `next` dist-tag, any
   other version to `latest`.

If the job fails half way, re-run it. It skips the packages that are on npm
at that version already. Running the workflow from the Actions tab is a dry
run that publishes nothing.

The job publishes through npm's trusted publishing. There is no token: npm
accepts the job's GitHub OIDC identity for each package configured to trust
it, and records provenance, which npmjs.com shows as where and from which
commit the package was built. The job runs in the `npm` environment, so
required reviewers set on that environment (Settings › Environments) hold
each release until someone approves it.

## The first release, by hand

npm only lets a package trust a workflow once the package exists, so 0.1.0
and any package added later are published from a checkout. You need an npm
account that can publish the `@swf2es` scope and the `swf2es` name.

```sh
pnpm install && pnpm build
node tests/packages/run.ts
npm login
node tools/publish.ts --dry-run    # what would go out, and in which order
node tools/publish.ts
```

These packages carry no provenance, because only CI can attest one.

npm creates a new package by staging its first version. The package shows
only a `0.0.0-stage` placeholder until npm releases that version, which can
take several minutes after `tools/publish.ts` has moved on. While the
version is held, publishing it again fails with "Cannot publish over
previously staged version". Wait, and check with `npm view <package>
versions`, rather than publishing again.

Then, on npmjs.com, configure each package under Settings › Trusted
publishing:

- **Publisher:** GitHub Actions
- **Organization or user:** `swf2es`
- **Repository:** `swf2es`
- **Workflow filename:** `release.yml`
- **Environment:** `npm`

After that, set "Require two-factor authentication and disallow tokens" in
the same settings. The workflow still publishes, and no token can.
