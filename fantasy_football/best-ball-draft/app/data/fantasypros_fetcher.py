"""
Scrape FantasyPros PPR season projections for QB/RB/WR/TE.

URL pattern:
  https://www.fantasypros.com/nfl/projections/{pos}.php?week=draft&scoring=PPR

The page is server-rendered HTML with a table id="data". The last column is
FPTS (full-season PPR fantasy points). Player names live in an <a> tag in the
first <td>.

Entry point: fetch_projections()
Returns: {player_name: {'fpts': float, 'pos': str}}
"""

import requests
from bs4 import BeautifulSoup

BASE_URL   = 'https://www.fantasypros.com/nfl/projections/{pos}.php'
POSITIONS  = ['qb', 'rb', 'wr', 'te']

_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.fantasypros.com/',
}


def _find_fpts_index(thead):
    """Return the column index of FPTS from the last header row."""
    rows = thead.find_all('tr') if thead else []
    if not rows:
        return None
    headers = [th.get_text(strip=True).upper() for th in rows[-1].find_all('th')]
    for i, h in enumerate(headers):
        if 'FPTS' in h or ('FANT' in h and 'PT' in h):
            return i
    return len(headers) - 1 if headers else None


def _parse_table(table, pos):
    """Extract (player_name, fpts) pairs from a FantasyPros projections table."""
    thead = table.find('thead')
    tbody = table.find('tbody')
    if not thead or not tbody:
        return []

    fpts_idx = _find_fpts_index(thead)
    if fpts_idx is None:
        return []

    results = []
    for tr in tbody.find_all('tr'):
        cells = tr.find_all('td')
        if len(cells) <= fpts_idx:
            continue

        # Player name: prefer <a class="player-name">, then any <a>, then cell text
        name_cell = cells[0]
        link = (
            name_cell.find('a', class_='player-name') or
            name_cell.find('a', class_=lambda c: c and 'name' in str(c)) or
            name_cell.find('a')
        )
        name = (link or name_cell).get_text(strip=True)
        if not name:
            continue

        fpts_text = cells[fpts_idx].get_text(strip=True).replace(',', '')
        try:
            fpts = float(fpts_text)
        except ValueError:
            continue

        if fpts > 0:
            results.append((name, fpts))

    return results


def fetch_projections(verbose=True):
    """
    Fetch FantasyPros PPR season projections for all skill positions.
    Returns {player_name: {'fpts': float, 'pos': str}}, or {} on total failure.
    Individual position failures are skipped with a warning.
    """
    result = {}

    for pos in POSITIONS:
        if verbose:
            print(f'  [FantasyPros] Fetching {pos.upper()} projections…')
        try:
            resp = requests.get(
                BASE_URL.format(pos=pos),
                params={'week': 'draft', 'scoring': 'PPR'},
                headers=_HEADERS,
                timeout=20,
            )
            resp.raise_for_status()
        except Exception as e:
            if verbose:
                print(f'  [FantasyPros] {pos.upper()} request failed: {e}')
            continue

        soup  = BeautifulSoup(resp.text, 'html.parser')
        table = soup.find('table', {'id': 'data'}) or soup.find('table')

        if not table:
            if verbose:
                print(f'  [FantasyPros] No table found for {pos.upper()} — page may require JS rendering')
            continue

        rows = _parse_table(table, pos)
        for name, fpts in rows:
            result[name] = {'fpts': fpts, 'pos': pos.upper()}

        if verbose:
            print(f'  [FantasyPros] {len(rows)} {pos.upper()} players')

    return result
