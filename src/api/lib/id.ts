import { v7 as uuidv7 } from 'uuid';

export function createId(prefix: string) {
  return `${prefix}_${uuidv7().replaceAll('-', '')}`;
}
