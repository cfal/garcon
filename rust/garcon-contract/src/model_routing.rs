//! Ports common/model-routing.ts.

const ENDPOINT_MODEL_VALUE_SEPARATOR: char = ':';

pub fn endpoint_model_option_value(endpoint_id: &str, raw_model: &str) -> String {
    format!("{endpoint_id}{ENDPOINT_MODEL_VALUE_SEPARATOR}{raw_model}")
}

pub fn raw_model_from_endpoint_option_value<'a>(
    endpoint_id: &str,
    selected_model: &'a str,
) -> &'a str {
    selected_model
        .strip_prefix(endpoint_id)
        .and_then(|value| value.strip_prefix(ENDPOINT_MODEL_VALUE_SEPARATOR))
        .unwrap_or(selected_model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_only_the_chosen_endpoint_prefix() {
        let selected = endpoint_model_option_value("here", "model:latest");
        assert_eq!(selected, "here:model:latest");
        assert_eq!(
            raw_model_from_endpoint_option_value("here", &selected),
            "model:latest"
        );
        assert_eq!(
            raw_model_from_endpoint_option_value("other", &selected),
            selected
        );
        assert_eq!(
            raw_model_from_endpoint_option_value("here", "hereafter:model"),
            "hereafter:model"
        );
        assert_eq!(
            raw_model_from_endpoint_option_value("here", "here:here:model"),
            "here:model"
        );
    }
}
