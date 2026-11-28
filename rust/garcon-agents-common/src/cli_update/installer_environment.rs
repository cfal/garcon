use indexmap::IndexMap;

pub type Environment = IndexMap<String, String>;

const PROVIDER_CREDENTIAL_KEYS: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
];

pub fn installer_environment(overrides: Environment) -> Environment {
    let inherited = std::env::vars_os().filter_map(|(key, value)| {
        Some((
            key.into_string().ok()?,
            value.to_string_lossy().into_owned(),
        ))
    });
    installer_environment_from(inherited, overrides)
}

fn installer_environment_from(
    inherited: impl IntoIterator<Item = (String, String)>,
    overrides: Environment,
) -> Environment {
    let mut environment: Environment = inherited
        .into_iter()
        .filter(|(key, _)| {
            key != "CLAUDECODE"
                && !key.ends_with("_API_KEY")
                && !PROVIDER_CREDENTIAL_KEYS.contains(&key.as_str())
        })
        .collect();
    environment.extend(overrides);
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withholds_every_provider_credential_and_keeps_installer_settings() {
        let inherited = PROVIDER_CREDENTIAL_KEYS
            .iter()
            .copied()
            .chain([
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
                "AMP_API_KEY",
                "OPENROUTER_API_KEY",
                "CLAUDECODE",
                "NPM_TOKEN",
                "HTTPS_PROXY",
            ])
            .map(|key| (key.to_owned(), format!("synthetic-{key}")));
        let environment = installer_environment_from(
            inherited,
            Environment::from([("CODEX_HOME".into(), "/synthetic/codex".into())]),
        );
        assert_eq!(
            environment,
            Environment::from([
                ("NPM_TOKEN".into(), "synthetic-NPM_TOKEN".into()),
                ("HTTPS_PROXY".into(), "synthetic-HTTPS_PROXY".into()),
                ("CODEX_HOME".into(), "/synthetic/codex".into())
            ])
        );
    }
}
