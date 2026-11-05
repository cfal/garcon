const FINGERPRINT_SELECTION = `number updatedAt isDraft headRefOid baseRefOid mergeable reviewDecision
        reviews{totalCount} reviewThreads{totalCount}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;

// Policy and idempotency inputs expose every connection's continuation.
export const LIST_QUERY = `query($owner:String!,$name:String!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){
    nameWithOwner url
    pullRequests(states:OPEN,first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        ${FINGERPRINT_SELECTION}
        title url state createdAt
        author{login __typename}
        authorAssociation headRefName baseRefName isCrossRepository
        additions deletions changedFiles
        labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}}
        reviewRequests(first:100){nodes{requestedReviewer{__typename ... on User{login}}} pageInfo{hasNextPage endCursor}}
      }
    }
  }
}`;

// Aliases `r<index>` to one repository each, whose owner and name arrive as
// `$o<index>` and `$n<index>`. The first page is all a fingerprint reads; a
// repository with more open pull requests reports `hasNextPage` and is read in full.
export function fingerprintQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map(index => `$o${index}:String!,$n${index}:String!`).join(',');
  const repositories = indexes.map(index => `r${index}:repository(owner:$o${index},name:$n${index}){
    nameWithOwner url
    pullRequests(states:OPEN,first:100){pageInfo{hasNextPage} nodes{
        ${FINGERPRINT_SELECTION}
    }}
  }`).join('\n  ');
  return `query(${variables}){\n  viewer{id login}\n  ${repositories}\n}`;
}

export const REQUESTED_QUERY = `query($requested:String!,$endCursor:String){
  viewer{id login}
  requested:search(query:$requested,type:ISSUE,first:100,after:$endCursor){
    issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number}}
  }
}`;

export const LABELS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){nameWithOwner url pullRequest(number:$number){
    labels(first:100,after:$endCursor){nodes{name} pageInfo{hasNextPage endCursor}}
  }}
}`;

export const REVIEW_REQUESTS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){nameWithOwner url pullRequest(number:$number){
    reviewRequests(first:100,after:$endCursor){nodes{requestedReviewer{__typename ... on User{login}}} pageInfo{hasNextPage endCursor}}
  }}
}`;

export const REVIEW_TARGET_QUERY = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){nameWithOwner url pullRequest(number:$number){
    number state headRefOid
    comments(first:100,after:$endCursor){nodes{id url isMinimized author{login ... on Node{id}} body} pageInfo{hasNextPage endCursor}}
  }}
}`;
