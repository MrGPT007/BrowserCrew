// Shared persistence mutex only. Keep slow validation and task/provider work outside this critical section.
let scheduleStateMutation = null;

export async function withScheduleStateMutation(work) {
  const previous = scheduleStateMutation || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  scheduleStateMutation = current;
  try {
    return await current;
  } finally {
    if (scheduleStateMutation === current) scheduleStateMutation = null;
  }
}
