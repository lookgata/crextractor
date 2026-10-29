import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { download } from 'molnia';

const downloadApk = async (target = 'mobile') => {
  const q = Buffer.from('myCPU=arm64-v8a,armeabi-v7a,armeabi&leanback=0')
    .toString('base64')
    .replace(/=+$/, '');
  const listUrl = `https://ws75-cache.aptoide.com/api/7/listAppVersions?package_name=com.crunchyroll.crunchyroid&q=${q}&aab=1&limit=15`;
  const listRes = await fetch(listUrl).then((r) => r.json());
  const versions = listRes.list || [];
  const match = versions.find((v) =>
    target === 'mobile' ? v.file.vercode < 10000 : v.file.vercode >= 20000
  );
  if (!match?.id) {
    console.error(`Unable to find ID for ${target} APK`);
    return;
  }
  const metaUrl = `https://ws75-cache.aptoide.com/api/7/app/getMeta?app_id=${match.id}`;
  const metaJson = await fetch(metaUrl).then((r) => r.json());
  const url = metaJson.data.file.path;
  const filepath = join(process.cwd(), 'crunchyroll.apk');
  await download(url, {
    output: filepath,
    onError: (error) => console.error(error),
  });
  return filepath;
};

const decompileApk = (apkPath) => {
  try {
    execSync(`jadx ${apkPath}`, { stdio: 'inherit' });
  } catch (error) {}
  return apkPath.replace('.xapk', '').replace('.apk', '');
};

const findConfigurationImpl = async (sourcesDir) => {
  const entries = await readdir(sourcesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleDir = join(sourcesDir, entry.name);
    const moduleEntries = await readdir(moduleDir, { withFileTypes: true });
    for (const moduleFile of moduleEntries) {
      if (moduleFile.isDirectory()) continue;
      const moduleFilePath = join(moduleDir, moduleFile.name);
      const moduleContents = await readFile(moduleFilePath, 'utf8');
      if (moduleContents.includes(' ConfigurationImpl.kt')) {
        return moduleContents;
      }
    }
  }
};

const parseCredentials = async (decompiledDir) => {
  const sourcesDir = join(decompiledDir, 'sources');
  const configurationImpl = await findConfigurationImpl(sourcesDir);
  if (configurationImpl) {
    const lines = configurationImpl.split('\n');
    const startIndex = lines.findIndex((line) => line.includes('https://sso.crunchyroll.com'));
    const endIndex = lines.findIndex((line) => line.includes('CR-AndroidMobile-SSAI-Prod'));
    const results = lines
      .slice(startIndex, endIndex)
      .map((line) => line.replaceAll(';', ''))
      .map((line) => line.replaceAll('"', ''))
      .map((line) => line.split('= ')[1])
      .map((line) => line.trim());
    const [, , id, secret] = results;
    if (id && secret) return { id, secret };
  }

  const constantsPath = join(
    decompiledDir,
    'sources',
    'com',
    'crunchyroll',
    'api',
    'util',
    'Constants.java',
  );
  const constants = await readFile(constantsPath, 'utf8');
  return {
    id: constants.split(' PROD_CLIENT_ID = "')[1].split('"')[0],
    secret: constants.split(' PROD_CLIENT_SECRET = "')[1].split('"')[0],
  };
};

const parseVersion = async (decompiledDir) => {
  const manifestJsonPath = join(decompiledDir, 'resources', 'manifest.json');
  const manifestXmlPath = join(decompiledDir, 'resources', 'AndroidManifest.xml');
  if (existsSync(manifestJsonPath)) {
    const manifestContent = await readFile(manifestJsonPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    const version = `${manifest.version_name} (${manifest.version_code})`;
    return version;
  } else if (existsSync(manifestXmlPath)) {
    const manifest = await readFile(manifestXmlPath, 'utf8');
    const version = `${manifest.match(/versionName="([^"]+)"/)[1]} (${manifest.match(/versionCode="([^"]+)"/)[1]})`;
    return version;
  }
};

const extract = async ({ target = 'mobile', output, cleanup = false } = {}) => {
  console.log('Downloading APK...');
  const apkPath = await downloadApk(target);

  if (!existsSync(apkPath)) {
    console.error('Unable to find APK (possibly a download error)');
    return;
  }

  console.log('Decompiling APK...');
  const decompiledDir = decompileApk(apkPath);

  console.log('Parsing version...');
  const version = await parseVersion(decompiledDir);

  console.log('Parsing credentials...');
  const { id, secret } = await parseCredentials(decompiledDir);
  const encoded = Buffer.from(`${id}:${secret}`).toString('base64');
  const authorization = `Basic ${encoded}`;

  console.log(`Cleaning up files...`);
  if (cleanup) await rm(apkPath, { recursive: true, force: true });
  if (cleanup) await rm(decompiledDir, { recursive: true, force: true });

  console.log(`Version: ${version}`);
  console.log(`ID: ${id}`);
  console.log(`Secret: ${secret}`);
  console.log(`Encoded ID with secret: ${encoded}`);
  console.log(`Authorization: ${authorization}`);

  if (output) {
    await writeFile(
      output,
      JSON.stringify({ version, id, secret, encoded, authorization }, null, 2),
    );
  }

  return { version, id, secret, encoded, authorization };
};

const pull = async ({ target = 'mobile' } = {}) => {
  const url = `https://raw.githubusercontent.com/lookgata/crextractor/refs/heads/main/credentials.${target}.json`;
  const credentials = await fetch(url).then((response) => response.json());
  return credentials;
};

export { extract, pull };
