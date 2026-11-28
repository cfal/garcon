//! Ports common/garcon-command-text.ts.

pub fn normalize_garcon_command_body(value: &str) -> &str {
    let value = value
        .strip_prefix("\r\n")
        .or_else(|| value.strip_prefix('\n'))
        .unwrap_or(value);
    value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_at_most_one_line_ending_at_each_boundary() {
        assert_eq!(
            normalize_garcon_command_body("\r\n\nbody\n\r\n"),
            "\nbody\n"
        );
        assert_eq!(normalize_garcon_command_body("\n  body  \n"), "  body  ");
        assert_eq!(normalize_garcon_command_body("\rbody\r"), "\rbody\r");
        assert_eq!(normalize_garcon_command_body("\r\n"), "");
    }
}
