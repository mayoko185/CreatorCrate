# Downloads

Served artifacts for the web application.

## Windows helper installer

The Settings page's "Download Open locally installer" link serves the shared
Windows helper installer. Its single `OpenLocally.exe` handles both Open
Locally (`creatorcrate-open://`) and the native manual Social Preparation
companion (`creatorcrate-social://`). The link serves
`/downloads/creatorcrate-open-locally-setup.exe`, which maps to:

    downloads/CreatorCrate.OpenLocally-Setup.exe

The executable is built from the `helper/windows` sources using the Inno
Setup script `helper/windows/installer/CreatorCrate.OpenLocally.iss`
(see that file's header for the build steps) and must be placed here before
building the Docker image — the Dockerfile copies this whole directory into
the runtime image.

The repository intentionally tracks `downloads/CreatorCrate.OpenLocally-Setup.exe`
as the shipped installer. Its explicit `.gitignore` exception preserves this
deployment artifact for the download route and Docker runtime image.

The helper is published from `net10.0-windows` as a self-contained,
single-file `win-x64` executable. The installer retains its stable AppId and
per-user install directory so compatible releases upgrade in place, refresh
both protocol registrations, and preserve trusted-origin/media-root settings.
The delivered helper supports manual copying of prepared social text, dragging
prepared local files, and explicit **Mark as posted** confirmation back to
CreatorCrate after the operator manually publishes. Close, Copy, and Drag do not
mean Posted. The helper does not post to, control, or automate social websites.

While the artifact is absent, the download route returns a clean 404 — that
is the intended behavior in development.
