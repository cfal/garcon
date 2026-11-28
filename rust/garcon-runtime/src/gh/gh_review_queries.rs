//! GitHub CLI GraphQL query text, including every continuation.

pub const LIST_QUERY: &str = "query($owner:String!,$name:String!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){
    nameWithOwner url
    pullRequests(states:OPEN,first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title url isDraft state createdAt updatedAt
        author{login __typename}
        authorAssociation headRefName baseRefName headRefOid isCrossRepository
        additions deletions changedFiles reviewDecision
        labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}}
        reviewRequests(first:100){nodes{requestedReviewer{__typename ... on User{login}}} pageInfo{hasNextPage endCursor}}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      }
    }
  }
}";

pub const REQUESTED_QUERY: &str = "query($requested:String!,$endCursor:String){
  viewer{id login}
  requested:search(query:$requested,type:ISSUE,first:100,after:$endCursor){
    issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number}}
  }
}";

pub const LABELS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){nameWithOwner url pullRequest(number:$number){
    labels(first:100,after:$endCursor){nodes{name} pageInfo{hasNextPage endCursor}}
  }}
}";

pub const REVIEW_REQUESTS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){nameWithOwner url pullRequest(number:$number){
    reviewRequests(first:100,after:$endCursor){nodes{requestedReviewer{__typename ... on User{login}}} pageInfo{hasNextPage endCursor}}
  }}
}";

pub const REVIEW_TARGET_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  viewer{id login}
  repository(owner:$owner,name:$name){nameWithOwner url pullRequest(number:$number){
    number state headRefOid
    comments(first:100,after:$endCursor){nodes{id url isMinimized author{login ... on Node{id}} body} pageInfo{hasNextPage endCursor}}
  }}
}";
