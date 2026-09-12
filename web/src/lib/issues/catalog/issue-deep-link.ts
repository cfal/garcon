import { issueId } from '$shared/issue-validation';

export function selectedIssueFromUrl(url: URL): string | null {
	const values = url.searchParams.getAll('issue');
	if (values.length !== 1) return null;
	try {
		return issueId(values[0]);
	} catch {
		return null;
	}
}
