#!/usr/bin/env bash
# Publishes the GitHub release for the version in package.json.
#
# Called by the release job of .github/workflows/build.yml, the only job that
# has write access to the repository. It needs the GitHub CLI and standard
# shell tools, nothing else: no npm packages and no build tooling run here.
#
#   UPDATE_NOTES=true   only rewrite title and notes of the existing release
#   otherwise           publish the installer from bin/ (built by the build job)
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}"

VERSION=$(jq -r '.version' package.json)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "::error::package.json version '$VERSION' is not a valid release version"
  exit 1
fi
TAG="v$VERSION"
TITLE="LargeFileBuster $TAG"

# Notes: the hand-written file for this version (if there is one), followed by
# the change list GitHub generates from the merged pull requests.
write_notes() {
  NOTES=$(mktemp)
  local handwritten="docs/release-notes/$TAG.md"
  if [[ -f "$handwritten" ]]; then
    cat "$handwritten" >> "$NOTES"
    printf '\n\n---\n\n' >> "$NOTES"
  fi
  gh api "repos/$GITHUB_REPOSITORY/releases/generate-notes" \
    -f tag_name="$TAG" -f target_commitish="$GITHUB_SHA" --jq .body >> "$NOTES"
}

if [[ "${UPDATE_NOTES:-false}" == "true" ]]; then
  write_notes
  gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" \
    --title "$TITLE" --notes-file "$NOTES" --draft=false --latest
  exit 0
fi

INSTALLER="LargeFileBuster-Setup-$VERSION.exe"
ASSETS=("bin/$INSTALLER" "bin/$INSTALLER.blockmap" "bin/latest.yml")
for file in "${ASSETS[@]}"; do
  if [[ ! -s "$file" ]]; then
    echo "::error::Release file $file is missing or empty"
    exit 1
  fi
done

# latest.yml records the SHA-512 of the installer it was built with. Make sure
# the file about to be published is exactly that installer.
EXPECTED=$(awk '/^sha512: / { print $2; exit }' bin/latest.yml)
ACTUAL=$(openssl dgst -sha512 -binary "bin/$INSTALLER" | base64 -w0)
if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
  echo "::error::bin/$INSTALLER does not match the checksum in bin/latest.yml"
  exit 1
fi
write_notes
echo "Publishing $INSTALLER (SHA-256 $(sha256sum "bin/$INSTALLER" | cut -d' ' -f1)) as $TAG"

# Is there already a release for this tag? The list includes drafts, which the
# lookup by tag does not. One line per match: "true" for a draft, "false" for
# a published release.
EXISTING=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
  --jq ".[] | select(.tag_name == \"$TAG\") | .draft")

case "${EXISTING%%$'\n'*}" in
  "")
    # Also creates the tag on this commit if it does not exist yet.
    gh release create "$TAG" "${ASSETS[@]}" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
      --title "$TITLE" --notes-file "$NOTES" --latest
    ;;
  true)
    # An unpublished draft (prepared by hand, or left by an interrupted run):
    # complete it, and make sure its tag will point at the commit that was built.
    gh release upload "$TAG" "${ASSETS[@]}" --repo "$GITHUB_REPOSITORY" --clobber
    gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
      --title "$TITLE" --notes-file "$NOTES" --draft=false --latest
    ;;
  *)
    # Already published: add the files, but never replace a file people may have downloaded.
    gh release upload "$TAG" "${ASSETS[@]}" --repo "$GITHUB_REPOSITORY"
    gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" \
      --title "$TITLE" --notes-file "$NOTES" --latest
    ;;
esac
