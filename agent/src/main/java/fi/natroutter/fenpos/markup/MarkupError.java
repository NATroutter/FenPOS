package fi.natroutter.fenpos.markup;

/**
 * The ways a {@code data} element can be malformed.
 * <p>
 * Each constant carries the stable machine-readable code returned in the API's
 * {@code error} field. Clients branch on that code, so the strings are part of the public
 * contract and must not change with the enum constant names.
 */
public enum MarkupError {

    /** A tag name that is not in the registry. */
    UNKNOWN_TAG("unknown_tag"),

    /** A paired tag opened but never closed before the element ended. */
    UNCLOSED_TAG("unclosed_tag"),

    /** A closing tag with no matching open tag, or one closing the wrong tag. */
    UNEXPECTED_CLOSE_TAG("unexpected_close_tag"),

    /** A tag argument that is missing, malformed, or out of range. */
    INVALID_TAG_ARGUMENT("invalid_tag_argument"),

    /** An alignment tag that does not enclose the whole element, or a second one. */
    INVALID_ALIGN_SCOPE("invalid_align_scope"),

    /** A wrap tag that does not enclose the whole element, or a second one. */
    INVALID_WRAP_SCOPE("invalid_wrap_scope"),

    /** A rule tag sharing an element with other content. */
    INVALID_RULE_SCOPE("invalid_rule_scope"),

    /** A character that would be interpreted by the printer as a command. */
    CONTROL_CHARACTER("control_character");

    private final String apiCode;

    MarkupError(String apiCode) {
        this.apiCode = apiCode;
    }

    /** Returns the stable code placed in the API response's {@code error} field. */
    public String apiCode() {
        return apiCode;
    }
}
