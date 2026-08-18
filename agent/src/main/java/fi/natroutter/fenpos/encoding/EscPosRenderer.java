package fi.natroutter.fenpos.encoding;

import com.github.anastaciocintra.escpos.EscPos;
import com.github.anastaciocintra.escpos.EscPosConst;
import com.github.anastaciocintra.escpos.Style;
import fi.natroutter.fenpos.enums.Align;
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
        }
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
