let scheduleRunHistoryMutation = null;

export async function withScheduleRunHistoryMutation(work) {
  const previous = scheduleRunHistoryMutation || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  scheduleRunHistoryMutation = current;
  try {
    return await current;
  } finally {
    if (scheduleRunHistoryMutation === current) scheduleRunHistoryMutation = null;
  }
}
