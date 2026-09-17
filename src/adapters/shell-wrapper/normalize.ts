import type { NormalizedAction } from '../../core/types.js';

export function normalize(command: string): NormalizedAction {
  return {
    type: 'shell',
    command,
    raw: command,
    source: 'shell-wrapper',
  };
}