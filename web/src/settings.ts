// The quality setting on the HUD: Auto, or a tier the player picks, saved on this browser.
import { isTier, saveTier, type Tier } from './quality';

/** Shows the setting in `select`. `tier()` is the tier drawn now; `pick` applies a choice, null for Auto. */
export function qualitySetting(
  select: HTMLSelectElement,
  auto: boolean,
  tier: () => Tier,
  pick: (tier: Tier | null) => void,
) {
  const label = (t: Tier) => t[0]!.toUpperCase() + t.slice(1);
  const show = (isAuto: boolean) => {
    select.options[0]!.textContent = isAuto ? `Auto (${label(tier())})` : 'Auto';
    select.value = isAuto ? 'auto' : tier();
  };
  select.addEventListener('change', () => {
    const value = select.value;
    const picked = isTier(value) ? value : null;
    saveTier(picked);
    pick(picked);
    show(picked === null);
    select.blur();
  });
  // Keys go to the game even while the menu has focus: WASD and Space would otherwise pick options or open it.
  select.addEventListener('keydown', (event) => {
    event.preventDefault();
    select.blur();
  });
  show(auto);
  return { refresh: () => show(select.value === 'auto') };
}
