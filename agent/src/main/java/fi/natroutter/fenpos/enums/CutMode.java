package fi.natroutter.fenpos.enums;

/**
 * How completely a cut severs the paper.
 * <p>
 * Mirrors the {@code CUT} directive's {@code mode} in {@code fenpos/lib/link/protocol.ts}. Lives
 * here rather than on the wire record so {@link fi.natroutter.fenpos.link.Frames} stays free of
 * the render model, which carries its own cut mode for markup the agent's console parses.
 */
public enum CutMode {

    /** Severs the paper completely. */
    FULL,

    /** Leaves a small tab so the receipt stays attached until torn off. */
    PARTIAL
}
