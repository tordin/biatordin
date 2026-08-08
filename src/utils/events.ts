import { EventEmitter } from 'events';

class GlobalEventEmitter extends EventEmitter {}

export const biaEvents = new GlobalEventEmitter();
