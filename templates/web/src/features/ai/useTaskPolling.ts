'use client';
import { useEffect, useEffectEvent, useRef } from 'react';
import { aiApi } from './api';
import { failureInfo } from './errors';
import { isTerminalStatus, pollUntilDone } from './polling';
import type { AITaskView } from './types';

/**
 * Polls every non-terminal task in `tasks` with backoff (one loop per task id) and reports each
 * fresh view. Loops stop when the task settles, leaves the list, or the component unmounts.
 */
export function useTaskPolling(
  tasks: readonly AITaskView[],
  onUpdate: (task: AITaskView) => void,
  onStopped?: (taskId: string) => void,
) {
  const activeIds = tasks
    .filter((task) => !isTerminalStatus(task.status))
    .map((task) => task.id)
    .sort()
    .join(',');
  const update = useEffectEvent(onUpdate);
  const stopped = useEffectEvent((taskId: string) => onStopped?.(taskId));
  const loops = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const wanted = new Set(activeIds ? activeIds.split(',') : []);
    const running = loops.current;
    for (const [taskId, controller] of running)
      if (!wanted.has(taskId)) {
        controller.abort();
        running.delete(taskId);
      }
    for (const taskId of wanted) {
      if (running.has(taskId)) continue;
      const controller = new AbortController();
      running.set(taskId, controller);
      pollUntilDone({
        load: (signal) => aiApi.get(taskId, signal),
        isDone: (task) => isTerminalStatus(task.status),
        onUpdate: (task) => update(task),
        activityKey: (task) => `${task.status}:${task.progress ?? ''}:${task.stage ?? ''}`,
        isFatal: (error) => failureInfo(error).status === 404,
        signal: controller.signal,
        delayFirst: true,
      })
        .catch(() => {
          if (!controller.signal.aborted) stopped(taskId);
        })
        .finally(() => {
          if (running.get(taskId) === controller) running.delete(taskId);
        });
    }
  }, [activeIds]);

  useEffect(() => {
    const running = loops.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);
}
