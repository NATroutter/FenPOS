package fi.natroutter.fenpos.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests the agent's local store against a real SQLite file.
 *
 * <p>A real database rather than a fake, because the behaviour worth testing lives in it: that
 * the identity is genuinely a singleton, and that what was written survives the process closing
 * and reopening the file. A fake would assert that the code calls JPA the way the author
 * imagined, which is the kind of test that passes while the feature is broken.
 */
class AgentStoreTest {

    @TempDir
    Path directory;

    private Path databaseFile;
    private AgentStore store;

    private static AgentIdentity identity(String agentName) {
        return new AgentIdentity(
                "https://fenpos.example.com",
                "agent-1",
                agentName,
                "token-value",
                Instant.parse("2026-08-18T10:00:00Z"));
    }

    @BeforeEach
    void openStore() throws Exception {
        databaseFile = directory.resolve("state").resolve("agent.db");
        store = AgentStore.open(databaseFile);
    }

    @AfterEach
    void closeStore() {
        if (store != null) {
            store.close();
        }
    }

    @Test
    void createsTheDatabaseAndItsParentDirectory() {
        // The store lives on a mounted volume that may be empty on first boot, so it has to
        // build its own path rather than expect one.
        assertTrue(Files.exists(databaseFile), "database file should have been created");
    }

    @Test
    void reportsUnpairedBeforeAnythingIsStored() throws Exception {
        assertFalse(store.isPaired());
        assertTrue(store.identity().isEmpty());
    }

    @Test
    void storesAndReadsBackAnIdentity() throws Exception {
        store.saveIdentity(identity("kitchen"));

        var stored = store.identity().orElseThrow();
        assertEquals("https://fenpos.example.com", stored.serverUrl());
        assertEquals("agent-1", stored.agentId());
        assertEquals("kitchen", stored.agentName());
        assertEquals("token-value", stored.token());
        assertEquals(Instant.parse("2026-08-18T10:00:00Z"), stored.pairedAt());
        assertTrue(store.isPaired());
    }

    @Test
    void survivesReopening() throws Exception {
        store.saveIdentity(identity("kitchen"));
        store.close();

        // The point of the store: a container recreate must not cost the operator a re-pair.
        try (AgentStore reopened = AgentStore.open(databaseFile)) {
            assertEquals("kitchen", reopened.identity().orElseThrow().agentName());
        }
    }

    @Test
    void keepsExactlyOneIdentityWhenPairedAgain() throws Exception {
        store.saveIdentity(identity("kitchen"));
        store.saveIdentity(identity("bar"));

        // Two identities would mean the agent connects as whichever row it read first, which
        // presents as a printer intermittently belonging to the wrong site.
        assertEquals("bar", store.identity().orElseThrow().agentName());
    }

    @Test
    void clearsAnIdentity() throws Exception {
        store.saveIdentity(identity("kitchen"));

        assertTrue(store.clearIdentity());
        assertFalse(store.isPaired());
    }

    @Test
    void reportsNothingToClearWhenUnpaired() throws Exception {
        assertFalse(store.clearIdentity());
    }

    @Test
    void clearingIsDurable() throws Exception {
        store.saveIdentity(identity("kitchen"));
        store.clearIdentity();
        store.close();

        try (AgentStore reopened = AgentStore.open(databaseFile)) {
            assertFalse(reopened.isPaired());
        }
    }

    @Test
    void doesNotPutTheTokenInItsDescription() {
        // toString reaches log lines by accident far more often than by design, and a token in
        // a support bundle is exactly the accident worth engineering against.
        assertFalse(identity("kitchen").toString().contains("token-value"));
    }

    @Test
    void closingTwiceIsHarmless() {
        store.close();
        store.close();
    }
}
