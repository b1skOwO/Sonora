import { fetch } from '@tauri-apps/plugin-http';
import i18n from '../i18n';
import { APP_VERSION, GITHUB_OWNER, GITHUB_REPO, GITHUB_REPO_EN } from './constants';
import { isNewerVersion } from './semver';

export interface GithubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
}

function stripLeadingV(version: string) {
  return version.replace(/^v/, '');
}

async function fetchRelease(repo: string): Promise<GithubRelease | null> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/releases/latest`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return (await response.json()) as GithubRelease;
      if (response.status < 500 && response.status !== 429) return null;
    } catch {
      // Try again, then fall back to GitHub's release feed if the API is down.
    }

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  return fetchReleaseFromFeed(repo).catch(() => null);
}

async function fetchReleaseFromFeed(repo: string): Promise<GithubRelease | null> {
  const response = await fetch(`https://github.com/${GITHUB_OWNER}/${repo}/releases.atom`);
  if (!response.ok) return null;

  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;

  const readTag = (tag: string) =>
    entry
      .match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1]
      ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim() ?? '';
  const link = entry.match(/<link\b[^>]*href="([^"]+)"/)?.[1] ?? '';
  const tagName = readTag('title').replace(/^\[([^\]]+)\].*$/, '$1');

  if (!tagName || !link) return null;

  return {
    tag_name: tagName,
    name: readTag('title'),
    body: '',
    html_url: link,
    published_at: readTag('updated'),
  };
}

export async function checkForAppUpdate(): Promise<GithubRelease | null> {
  const primaryRelease = await fetchRelease(GITHUB_REPO);
  if (!primaryRelease) return null;

  const latest = stripLeadingV(primaryRelease.tag_name);
  const current = stripLeadingV(APP_VERSION);
  if (!isNewerVersion(latest, current)) return null;

  const prefersEnglishRelease = !i18n.language?.startsWith('ru');
  if (prefersEnglishRelease) {
    const englishRelease = await fetchRelease(GITHUB_REPO_EN).catch(() => null);
    if (englishRelease && stripLeadingV(englishRelease.tag_name) === latest) {
      return englishRelease;
    }
  }

  return primaryRelease;
}
