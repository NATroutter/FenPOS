package fi.natroutter.fenpos.encoding;

import com.github.anastaciocintra.escpos.EscPos;
import com.github.anastaciocintra.escpos.EscPosConst;
import com.github.anastaciocintra.escpos.Style;
import com.github.anastaciocintra.escpos.barcode.BarCode;
import com.github.anastaciocintra.escpos.barcode.PDF417;
import com.github.anastaciocintra.escpos.barcode.QRCode;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import fi.natroutter.fenpos.markup.model.SpanStyle;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import java.util.EnumMap;
import java.util.Map;

/**
 * Renders wrapped lines into an ESC/POS byte stream.
 * <p>
 * This is the only class that touches escpos-coffee. Keeping the dependency confined here
 * is what lets the rest of the system — including {@link Codepage} in the configuration —
 * stay free of it.
 * <p>
 * The library's {@code write(Style, String)} re-sends the complete style preamble before
 * every write, seventeen bytes whether or not anything changed. On a 9600 baud serial link
 * a long receipt with several spans per line spends seconds transmitting redundant
 * commands, so this renderer emits a style only when it differs from the one already in
 * effect and writes the encoded text itself.
 */
public final class EscPosRenderer {

    /**
     * Maps the agent's codepages onto the library's tables. Held here rather than on
     * {@link Codepage} so the configuration model never references the library.
     */
    private static final Map<Codepage, EscPos.CharacterCodeTable> TABLES =
            new EnumMap<>(Codepage.class);

    static {
        TABLES.put(Codepage.CP437, EscPos.CharacterCodeTable.CP437_USA_Standard_Europe);
        TABLES.put(Codepage.CP850, EscPos.CharacterCodeTable.CP850_Multilingual);
        TABLES.put(Codepage.CP852, EscPos.CharacterCodeTable.CP852_Latin2);
        TABLES.put(Codepage.CP857, EscPos.CharacterCodeTable.CP857_Turkish);
        TABLES.put(Codepage.CP858, EscPos.CharacterCodeTable.CP858_Euro);
        TABLES.put(Codepage.CP860, EscPos.CharacterCodeTable.CP860_Portuguese);
        TABLES.put(Codepage.CP863, EscPos.CharacterCodeTable.CP863_Canadian_French);
        TABLES.put(Codepage.CP865, EscPos.CharacterCodeTable.CP865_Nordic);
        TABLES.put(Codepage.CP866, EscPos.CharacterCodeTable.CP866_Cyrillic_2);
        TABLES.put(Codepage.CP1250, EscPos.CharacterCodeTable.WCP1250_Latin2);
        TABLES.put(Codepage.CP1251, EscPos.CharacterCodeTable.WCP1251_Cyrillic);
        TABLES.put(Codepage.CP1252, EscPos.CharacterCodeTable.WPC1252);
        TABLES.put(Codepage.ISO8859_7, EscPos.CharacterCodeTable.ISO8859_7_Greek);
    }

    /** Character repeated to draw {@code <hr>}; prints on every device, unlike a graphic. */
    private static final char RULE_CHARACTER = '-';

    /** ESC, as a byte, for the one command this class assembles itself. */
    private static final byte ESC = 0x1B;

    /** {@code p}, the generate-pulse command that fires a cash drawer. */
    private static final byte PULSE = 0x70;

    /** Code 128 code set B: the full printable ASCII range. */
    private static final String CODE128_SET_B = "{B";

    private EscPosRenderer() {
    }

    /**
     * Renders lines into the byte stream to send to the printer.
     *
     * @param lines    lines already validated and wrapped
     * @param codepage character table to switch the printer to
     * @param linefeed terminator written after each line of text
     * @param columns  paper width, used to size {@code <hr>}
     * @return the complete ESC/POS payload for one job
     * @throws IOException if the underlying library fails to emit a command
     */
    public static byte[] render(List<Line> lines,
                                Codepage codepage,
                                Linefeed linefeed,
                                int columns) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        EscPos escpos = new EscPos(out);

        // A previous job that failed mid-print may have left the printer bold or
        // double-height; ESC @ guarantees each job starts from the documented defaults.
        escpos.initializePrinter();
        escpos.setCharacterCodeTable(table(codepage));

        RenderState state = new RenderState();
        for (Line line : lines) {
            renderLine(line, escpos, out, state, codepage, linefeed, columns);
        }

        escpos.flush();
        return out.toByteArray();
    }

    private static void renderLine(Line line,
                                   EscPos escpos,
                                   ByteArrayOutputStream out,
                                   RenderState state,
                                   Codepage codepage,
                                   Linefeed linefeed,
                                   int columns) throws IOException {
        for (Span span : line.spans()) {
            writeStyled(span.style(), line.align(), span.text(), out, state, codepage);
        }

        // A line carrying only directives must not advance the paper: "<cut>" should cut,
        // not print a blank line and then cut.
        if (!line.isDirectiveOnly()) {
            out.write(linefeed.bytes());
        }

        for (Directive directive : line.directives()) {
            emit(directive, escpos, out, state, codepage, line.align(), columns);
        }
    }

    /**
     * Writes text, preceding it with a style preamble only when the style actually changes.
     */
    private static void writeStyled(SpanStyle spanStyle,
                                    Align align,
                                    String text,
                                    ByteArrayOutputStream out,
                                    RenderState state,
                                    Codepage codepage) throws IOException {
        byte[] config = toLibraryStyle(spanStyle, align).getConfigBytes();
        if (!Arrays.equals(config, state.activeStyle)) {
            out.write(config);
            state.activeStyle = config;
        }
        out.write(text.getBytes(codepage.charset()));
    }

    private static void emit(Directive directive,
                             EscPos escpos,
                             ByteArrayOutputStream out,
                             RenderState state,
                             Codepage codepage,
                             Align align,
                             int columns) throws IOException {
        switch (directive) {
            case Directive.Cut cut -> escpos.cut(cut.mode() == Directive.Cut.Mode.PARTIAL
                    ? EscPos.CutMode.PART
                    : EscPos.CutMode.FULL);
            case Directive.Feed feed -> {
                escpos.feed(feed.lines());
                // The library's feed writes a default style preamble of its own, so
                // whatever style was in effect no longer is. Forget it, or the next span
                // would skip a preamble it now needs.
                state.activeStyle = null;
            }
            case Directive.Rule ignored -> {
                writeStyled(SpanStyle.PLAIN, align, String.valueOf(RULE_CHARACTER).repeat(columns),
                        out, state, codepage);
                out.write(new byte[]{EscPosConst.LF});
            }
            // Each symbol emits its own justification and, having done so, leaves the printer in
            // a state the cached style no longer describes. Forgetting it costs one preamble on
            // the next span; keeping it would cost a span printed in the wrong style.
            case Directive.Qr qr -> {
                try {
                    escpos.write(new QRCode()
                            .setJustification(justification(align))
                            .setSize(qr.size()), qr.content());
                } catch (IllegalArgumentException e) {
                    throw encodingFailure("QR code", e);
                }
                state.activeStyle = null;
            }
            case Directive.Barcode barcode -> {
                try {
                    escpos.write(new BarCode()
                            .setJustification(justification(align))
                            .setSystem(system(barcode.system())), barcodeData(barcode));
                } catch (IllegalArgumentException e) {
                    throw encodingFailure(barcode.system().name() + " barcode", e);
                }
                state.activeStyle = null;
            }
            case Directive.Pdf417 pdf417 -> {
                try {
                    escpos.write(new PDF417()
                            .setJustification(justification(align))
                            .setErrorLevel(errorLevel(pdf417.errorLevel())), pdf417.content());
                } catch (IllegalArgumentException e) {
                    throw encodingFailure("PDF417 symbol", e);
                }
                state.activeStyle = null;
            }
            // Alone among these, the pulse writes no style of its own and none of the printer's
            // state it touches is style, so the cached style still describes the printer.
            case Directive.Drawer drawer -> out.write(drawerPulse(drawer.pin()));
        }
    }

    /**
     * Labels an encoder's refusal so the reason reaches whoever wrote the markup.
     * <p>
     * Applied per symbol rather than around the whole render, so that an
     * {@link IllegalArgumentException} raised anywhere else — a style, a codepage lookup, a bug
     * in this class — keeps its own identity and stack instead of being reported as a bad job.
     */
    private static SymbolEncodingException encodingFailure(String what, IllegalArgumentException cause) {
        return new SymbolEncodingException(
                "this printer cannot encode that " + what + ": " + cause.getMessage(), cause);
    }

    /**
     * The bytes that fire a cash drawer: {@code ESC p m t1 t2}.
     * <p>
     * Assembled here rather than taken from the library's {@code pulsePin}, which encodes
     * {@code m} as 48 or 49. Both are valid — ESC/POS accepts 0, 1, 48 and 49 — but the panel's
     * raw-byte tool catalogues {@code 1B 70 00 19 FA} and {@code 1B 70 01 19 FA}, and an
     * operator who fires the drawer from that tool and then from a receipt should be able to
     * compare the two and see the same bytes.
     * <p>
     * The pulse is 25 units on and 250 off, in units of 2 ms: 50 ms is long enough to throw a
     * drawer solenoid, and the off time keeps a second kick from arriving before the first has
     * released.
     */
    private static byte[] drawerPulse(int pin) {
        return new byte[]{ESC, PULSE, pin == 5 ? (byte) 0x01 : (byte) 0x00, (byte) 0x19, (byte) 0xFA};
    }

    /**
     * Maps a 0..8 error correction level onto the library's constant.
     * <p>
     * Written out case by case rather than indexed by ordinal. {@code values()[level]} reads the
     * same today, but it makes how much damage a printed symbol survives depend on the order the
     * library happens to declare its constants in, which a version bump can change without
     * anything failing to compile.
     * <p>
     * The default is a backstop rather than a live path: {@link Directive.Pdf417} already refuses
     * a level outside 0..8, so nothing can reach it today. It throws
     * {@link IllegalArgumentException}, which the symbol's caller converts, rather than the
     * {@code ArrayIndexOutOfBoundsException} an index would raise — that one is nobody's to catch
     * and would escape onto the print path.
     */
    private static PDF417.PDF417ErrorLevel errorLevel(int level) {
        return switch (level) {
            case 0 -> PDF417.PDF417ErrorLevel._0;
            case 1 -> PDF417.PDF417ErrorLevel._1_Default;
            case 2 -> PDF417.PDF417ErrorLevel._2;
            case 3 -> PDF417.PDF417ErrorLevel._3;
            case 4 -> PDF417.PDF417ErrorLevel._4;
            case 5 -> PDF417.PDF417ErrorLevel._5;
            case 6 -> PDF417.PDF417ErrorLevel._6;
            case 7 -> PDF417.PDF417ErrorLevel._7;
            case 8 -> PDF417.PDF417ErrorLevel._8;
            default -> throw new IllegalArgumentException(
                    "PDF417 error level must be 0..8, got " + level);
        };
    }

    /**
     * The data a Code 128 command carries, which is never the content verbatim.
     * <p>
     * Code 128 chooses among three code sets and the ESC/POS command has no field for which, so
     * the selector lives in the data: {@code &#123;A}, {@code &#123;B} and {@code &#123;C} switch
     * code set, {@code &#123;1} through {@code &#123;4} are the FNC characters, and a literal
     * brace is written twice. What arrives from the server is plain data that knows nothing of
     * that convention, so every brace in it is doubled and code set B — the full printable ASCII
     * range — is named in front.
     * <p>
     * There is deliberately no path that passes content through unescaped. Letting a caller name
     * its own code set makes {@code &#123;Barcode} ambiguous between literal text and a code set
     * switch, and the server's preview, which encodes the same string as plain data, would then
     * disagree with the paper. A barcode that scans as the wrong thing is worse than one that
     * fails to print.
     */
    private static String barcodeData(Directive.Barcode barcode) {
        if (barcode.system() != BarcodeSystem.CODE128) {
            return barcode.content();
        }
        return CODE128_SET_B + barcode.content().replace("{", "{{");
    }

    /**
     * Maps a symbology onto the library's constant.
     * <p>
     * Function A ({@code GS k 0..6}) is chosen wherever it exists, because it is the older form
     * and the one cheap thermal printers implement most reliably. Code 93 and Code 128 have no
     * function A, so they use function B, which any printer offering those symbologies has.
     */
    private static BarCode.BarCodeSystem system(BarcodeSystem system) {
        return switch (system) {
            case UPCA -> BarCode.BarCodeSystem.UPCA;
            case UPCE -> BarCode.BarCodeSystem.UPCE_A;
            case EAN13 -> BarCode.BarCodeSystem.JAN13_A;
            case EAN8 -> BarCode.BarCodeSystem.JAN8_A;
            case CODE39 -> BarCode.BarCodeSystem.CODE39_A;
            case ITF -> BarCode.BarCodeSystem.ITF_A;
            case CODABAR -> BarCode.BarCodeSystem.CODABAR_A;
            case CODE93 -> BarCode.BarCodeSystem.CODE93_Default;
            case CODE128 -> BarCode.BarCodeSystem.CODE128;
        };
    }

    private static Style toLibraryStyle(SpanStyle style, Align align) {
        return new Style()
                .setBold(style.bold())
                .setUnderline(underline(style.underline()))
                .setFontSize(fontSize(style.widthMult()), fontSize(style.heightMult()))
                .setFontName(style.font() == Font.B
                        ? Style.FontName.Font_B
                        : Style.FontName.Font_A_Default)
                .setColorMode(style.invert()
                        ? Style.ColorMode.WhiteOnBlack
                        : Style.ColorMode.BlackOnWhite_Default)
                .setJustification(justification(align));
    }

    private static Style.Underline underline(int thickness) {
        return switch (thickness) {
            case 1 -> Style.Underline.OneDotThick;
            case 2 -> Style.Underline.TwoDotThick;
            default -> Style.Underline.None_Default;
        };
    }

    /**
     * Maps a 1..8 multiplier onto the library's size constants, which are declared in
     * ascending order so the ordinal is the multiplier minus one.
     */
    private static Style.FontSize fontSize(int multiplier) {
        return Style.FontSize.values()[multiplier - 1];
    }

    private static EscPosConst.Justification justification(Align align) {
        return switch (align) {
            case LEFT -> EscPosConst.Justification.Left_Default;
            case CENTER -> EscPosConst.Justification.Center;
            case RIGHT -> EscPosConst.Justification.Right;
        };
    }

    private static EscPos.CharacterCodeTable table(Codepage codepage) {
        EscPos.CharacterCodeTable table = TABLES.get(codepage);
        if (table == null) {
            throw new IllegalStateException("No printer table mapped for codepage " + codepage);
        }
        return table;
    }

    /** Style currently in effect on the printer, so unchanged styles are not re-sent. */
    private static final class RenderState {
        private byte[] activeStyle;
    }
}
