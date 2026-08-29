#!/usr/bin/env node

export function latticeTaskAvailable(status, taskId, planKey = '') {
  if (!status || typeof status !== 'object' || typeof taskId !== 'string' || !taskId) return false
  const candidates = [...(status.next_ready ?? []), ...(status.active_set ?? [])]
  return candidates.some(task => task?.task_id === taskId && (!planKey || task?.plan_key === planKey))
}
