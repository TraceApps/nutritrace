/**
 * Convert a structured sync connection issue into localized UI copy.
 * Keeping translation outside sync.js lets the sync engine remain UI-agnostic.
 */
export function describeConnectionIssue(issue, translate, includeLocalSaveNote = false) {
  if (!issue) return null;

  const title = issue.kind === 'no_network'
    ? translate('sync.connection.no_network_title')
    : translate('sync.connection.cant_reach_title', {
        values: { host: issue.host || translate('sync.connection.server_fallback') },
      });

  let detail;
  if (issue.kind === 'no_network') {
    detail = translate('sync.connection.reconnect');
  } else if (issue.kind === 'server_error') {
    detail = translate('sync.connection.server_error', { values: { status: issue.status } });
  } else if (issue.connectionType === 'cellular') {
    detail = translate('sync.connection.mobile_data');
  } else {
    detail = translate('sync.connection.check_connection');
  }

  if (includeLocalSaveNote) {
    detail += ` ${translate('sync.connection.saved_locally')}`;
  }
  // Amber when the device simply has no network (nothing is lost, it waits),
  // red when the server itself can't be reached or answers with an error.
  return { title, detail, tone: issue.kind === 'no_network' ? 'wait' : 'bad' };
}
