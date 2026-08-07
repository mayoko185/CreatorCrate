# Downloads

Served artifacts for the web application.

## Open locally installer

The Settings page's "Download Open locally installer" link serves
`/downloads/creatorcrate-open-locally-setup.exe`, which maps to:

    downloads/CreatorCrate.OpenLocally-Setup.exe

The executable is built from the `helper/windows` sources using the Inno
Setup script `helper/windows/installer/CreatorCrate.OpenLocally.iss`
(see that file's header for the build steps) and must be placed here before
building the Docker image — the Dockerfile copies this whole directory into
the runtime image.

This directory only ever contains the placeholder `.gitkeep` in the
repository; the `.exe` artifact itself is ignored by git (`/downloads/*.exe`
in `.gitignore` and `.git/info/exclude`) and is never committed.

While the artifact is absent, the download route returns a clean 404 — that
is the intended behavior in development.
