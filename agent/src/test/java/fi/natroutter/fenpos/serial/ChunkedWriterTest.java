package fi.natroutter.fenpos.serial;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class ChunkedWriterTest {

    @Test
    void writesInChunksOfTheBoundAndReportsTheTotal() {
        List<Integer> lengths = new ArrayList<>();
        byte[] payload = new byte[ChunkedWriter.CHUNK_BYTES * 2 + 100];

        int written = ChunkedWriter.write((buffer, length, offset) -> {
            lengths.add(length);
            return length;
        }, payload);

        assertEquals(payload.length, written);
        assertEquals(List.of(4096, 4096, 100), lengths);
    }

    @Test
    void stopsAtAShortWriteAndReportsWhatArrived() {
        byte[] payload = new byte[ChunkedWriter.CHUNK_BYTES * 3];

        int written = ChunkedWriter.write((buffer, length, offset) -> offset == 0 ? length : 10, payload);

        assertEquals(ChunkedWriter.CHUNK_BYTES + 10, written);
    }

    @Test
    void passesALostDeviceThrough() {
        assertEquals(-1, ChunkedWriter.write((buffer, length, offset) -> -1, new byte[10]));
    }
}
