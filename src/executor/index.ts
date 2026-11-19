import type { Executor } from './Executor';
import { SimulatorExecutor } from './SimulatorExecutor';

export * from './Executor';

/**
 * The active executor for the whole app. Swap this single binding
 * when a real execution layer (local agent / extension) is attached.
 */
export const executor: Executor = new SimulatorExecutor();
