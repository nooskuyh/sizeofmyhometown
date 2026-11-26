export const initialPlaces = [
  { name: 'Santa Cruz', region: 'California, United States', center: [-122.035, 36.967] },
  { name: 'Seoul', region: 'South Korea', center: [126.978, 37.551] },
];

export async function searchPlaces(query, signal) {
  const url = new URL('https://photon.komoot.io/api/');
  url.search = new URLSearchParams({ q: query, limit: '7', lang: 'en' });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Place search is unavailable.');
  const { features } = await response.json();
  const results = features.flatMap(({ properties, geometry }) => {
    if (geometry?.type !== 'Point') return [];

    const { name = properties.street, city, county, state, country } = properties;
    if (!name) return [];

    const region = [...new Set([city, county, state, country])].filter((part) => part && part !== name);
    return [{ name, region: region.join(', '), center: geometry.coordinates }];
  });
  return results;
}

export function setupSearch(pane, choosePlace) {
  const details = pane.querySelector('.search');
  const form = pane.querySelector('.search-form');
  const input = form.querySelector('input[type=search]');
  const status = pane.querySelector('.search-status');
  const results = pane.querySelector('.search-results');
  let request;

  details.addEventListener('toggle', () => {
    if (details.open) {
      input.focus();
    } else {
      request?.abort();
    }
  });
  details.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    details.open = false;
    details.querySelector('summary').focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (details.open && !details.contains(event.target)) details.open = false;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query.length < 2) {
      status.textContent = 'Enter at least two characters.';
      return;
    }

    request?.abort();
    request = new AbortController();
    const { signal } = request;
    results.replaceChildren();
    status.textContent = 'Searching…';
    try {
      const places = await searchPlaces(query, signal);
      if (signal.aborted) return;
      status.textContent = places.length ? '' : 'No matches. Try a city and country.';
      for (const place of places) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        const name = document.createElement('strong');
        const region = document.createElement('span');
        name.textContent = place.name;
        region.textContent = place.region;
        button.append(name, region);
        button.addEventListener('click', () => {
          choosePlace(place);
          details.open = false;
          input.value = '';
          results.replaceChildren();
          details.querySelector('summary').focus();
        });
        item.append(button);
        results.append(item);
      }
    } catch {
      if (!signal.aborted) status.textContent = 'Search is unavailable. Try again in a moment.';
    }
  });
}
