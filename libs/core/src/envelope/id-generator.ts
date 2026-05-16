import { v7 as uuidv7 } from 'uuid';

export function newMessageId(): string {
  return uuidv7();
}
