package fi.natroutter.fenpos.enums;

/**
 * Linear barcode symbologies the {@code &lt;barcode&gt;} markup tag can select.
 * <p>
 * Mirrors {@code BarcodeSystem} in {@code fenpos/lib/domain/enums.ts}. The two must not drift:
 * a symbology the panel accepts but the agent cannot render becomes a job that fails after it
 * was already acknowledged.
 */
public enum BarcodeSystem {

    /** UPC-A, twelve digits including the check digit. */
    UPCA,

    /** UPC-E, the zero-suppressed six-digit form of UPC-A. */
    UPCE,

    /** EAN-13, thirteen digits including the check digit. */
    EAN13,

    /** EAN-8, eight digits including the check digit. */
    EAN8,

    /** Code 39: digits, uppercase letters, space, and the symbols {@code -.$/+%}. */
    CODE39,

    /** Interleaved 2 of 5: digits only, encoded two per character pair. */
    ITF,

    /** Codabar: digits and the symbols {@code -$:./+}, bracketed by start/stop characters A-D. */
    CODABAR,

    /** Code 93: a denser superset of Code 39's alphabet. */
    CODE93,

    /**
     * Code 128: the full printable ASCII range, always in code set B.
     * <p>
     * Not automatic. {@code EscPosRenderer.barcodeData} writes a fixed {@code {B} in front of the
     * data and doubles every brace, because letting the content name its own code set would make
     * {@code {Barcode} ambiguous between literal text and a switch. So a symbol is eleven modules
     * per character throughout, and set C's two-digits-per-character packing never happens — which
     * is what the server's {@code code128SetBModules} measures against. This comment said
     * "switching code sets automatically" while the renderer forced set B, and the server believed
     * it: sixteen digits were charged at 246 dots and printed at 422.
     */
    CODE128
}
