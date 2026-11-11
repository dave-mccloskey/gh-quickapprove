export function nextRelease(tags, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  const prefix = `${part('year')}.${part('month')}.${part('day')}`;
  const sequences = tags
    .filter((tag) => tag.startsWith(`${prefix}.`))
    .map((tag) => {
      chromeVersion(tag);
      return Number(tag.split('.')[3]);
    });
  const release = `${prefix}.${Math.max(0, ...sequences) + 1}`;
  chromeVersion(release);
  return release;
}

export function chromeVersion(release) {
  if (!/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/.test(release)) throw new Error('Invalid release name.');
  const [year, month, day, sequence] = release.split('.').map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    sequence > 65535
  ) {
    throw new Error('Release date or sequence is outside the supported range.');
  }
  return [year, month, day, sequence].join('.');
}
