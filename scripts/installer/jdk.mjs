// ISSUE-148: resolve a Temurin JDK from Adoptium's metadata API. Upstream does
// not publish a stable versioned URL, so the API supplies both download link
// and SHA-256; the resolved pair is recorded in the install manifest.
const ARCH = { x64: "x64", arm64: "aarch64" };
const OS = { win32: "windows", darwin: "mac", linux: "linux" };

export async function resolveJdk({
  major = 21,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
} = {}) {
  const os = OS[platform];
  const architecture = ARCH[arch] ?? arch;
  if (!os) throw new Error(`unsupported platform for managed JDK: ${platform}`);
  const url =
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    `?architecture=${architecture}&image_type=jdk&os=${os}&vendor=eclipse`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Adoptium metadata failed (${response.status})`);
  const assets = await response.json();
  const asset = assets[0];
  if (!asset?.binary?.package) throw new Error("Adoptium returned no JDK package");
  return {
    version: asset.version?.semver ?? String(major),
    url: asset.binary.package.link,
    sha256: asset.binary.package.checksum,
    archive: /\.(zip)$/.test(asset.binary.package.name) ? "zip" : "tar",
  };
}
