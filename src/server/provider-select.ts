import pc from 'picocolors';
import * as p from '@clack/prompts';

export interface ServerProviderOption {
  id: string;
  name: string;
  modelCount: number;
}

function isSelected(list: string[], id: string): boolean {
  return list.includes(id);
}

/** Saved provider ids still available; empty when nothing saved yet (add-to-expose flow). */
export function resolveInitialServerProviders(
  initial: string[] | undefined,
  available: ServerProviderOption[],
): string[] {
  if (!initial?.length) return [];
  return initial.filter(id => available.some(provider => provider.id === id));
}

export async function selectServerProviders(
  available: ServerProviderOption[],
  initial: string[] | undefined,
): Promise<string[] | null> {
  if (available.length === 0) {
    p.log.warn('No providers available to expose.');
    return null;
  }

  let selected = resolveInitialServerProviders(initial, available);

  const lookup = new Map(available.map(provider => [provider.id, provider]));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    type MenuChoice = string;
    const options: Array<{ value: MenuChoice; label: string; hint: string }> = [];

    for (let i = 0; i < selected.length; i++) {
      const id = selected[i]!;
      const provider = lookup.get(id);
      const label = provider
        ? `★ ${provider.name}`
        : pc.dim(`★ ${id} — provider gone`);
      const hint = provider
        ? `${provider.modelCount} model${provider.modelCount !== 1 ? 's' : ''}`
        : 'select to remove';
      options.push({ value: `prov-${i}`, label, hint: 'select to remove' });
    }

    const unselected = available.filter(provider => !isSelected(selected, provider.id));
    options.push({
      value: '__add__',
      label: unselected.length === 0
        ? pc.dim('+ Add a provider → (all providers selected)')
        : '+ Add a provider →',
      hint: unselected.length === 0
        ? ''
        : `${unselected.length} more available`,
    });
    options.push({ value: '__all__', label: 'Expose all providers', hint: `${available.length} total` });
    if (selected.length > 0) {
      options.push({ value: '__clear__', label: 'Clear all', hint: 'start over' });
    }
    options.push({ value: '__done__', label: 'Done', hint: '' });

    const header = selected.length === 0
      ? `Exposed providers (0/${available.length}) — add providers to expose`
      : `Exposed providers (${selected.length}/${available.length}) — select to stop exposing`;

    const choice = await p.select<string>({
      message: header,
      options,
      initialValue: '__done__',
    });

    if (p.isCancel(choice) || choice === '__done__') {
      if (selected.length === 0) {
        p.log.warn('Select at least one provider to expose.');
        continue;
      }
      break;
    }

    if (choice === '__all__') {
      selected = available.map(provider => provider.id);
      p.log.success(`Exposing all ${available.length} providers.`);
      continue;
    }

    if (choice === '__clear__') {
      selected = [];
      p.log.success('Cleared provider list — add the ones you want to expose.');
      continue;
    }

    if (choice === '__add__') {
      if (unselected.length === 0) continue;

      const picked = await p.select<string>({
        message: 'Which provider?',
        options: unselected.map(provider => ({
          value: provider.id,
          label: provider.name,
          hint: `${provider.modelCount} model${provider.modelCount !== 1 ? 's' : ''}`,
        })),
      });
      if (p.isCancel(picked)) continue;
      selected = [...selected, picked];
      continue;
    }

    if (choice.startsWith('prov-')) {
      const idx = parseInt(choice.slice(5), 10);
      const id = selected[idx];
      if (!id) continue;
      const provider = lookup.get(id);
      selected = selected.filter((_, i) => i !== idx);
      p.log.success(`Removed ${provider?.name ?? id}.`);
    }
  }

  return selected;
}
