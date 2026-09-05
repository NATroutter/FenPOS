package fi.natroutter.fenpos.store;

import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Persistence;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * The agent's local database.
 *
 * <p>Holds the one thing the agent must survive a restart with: its identity. The device
 * configuration and the jobs in flight are deliberately not here — the server pushes a whole
 * configuration snapshot on every connection, and a job resurrected after a restart would print
 * something the customer stopped waiting for long ago.
 *
 * <p>Owns the {@link EntityManagerFactory} for the process and must be closed at shutdown. Held
 * as an ordinary object rather than a static so tests can open a store on a temporary file
 * without disturbing a running agent.
 */
public class AgentStore implements AutoCloseable {

    /** Persistence unit assembled programmatically; see {@link #open(Path, Consumer)}. */
    private static final String UNIT_NAME = "fenpos-agent";

    /** Directory mode for the data directory. Nobody but the owner may even traverse it. */
    private static final String DIRECTORY_MODE = "rwx------";

    /** File mode for the database itself, as defence behind the directory. */
    private static final String FILE_MODE = "rw-------";

    /**
     * Pins SQLite to a rollback journal instead of leaving the mode to the driver's default.
     *
     * <p>{@link #clearIdentity()} overwrites a credential's bytes in place before deleting its
     * row, and that only clears the credential under this mode: a rollback journal writes the
     * overwrite straight into the database file, where the later delete finds it. Under
     * write-ahead logging the overwrite would instead land in a {@code -wal} sibling file, and
     * the old value would still be readable from the main file until the next checkpoint. Setting
     * this explicitly means a driver upgrade or a "switch to WAL for durability" change has to
     * touch this line to defeat that, rather than doing it silently.
     */
    private static final String JOURNAL_MODE_PARAM = "?journal_mode=delete";

    private static final SecureRandom RANDOM = new SecureRandom();

    private final EntityManagerFactory factory;

    private AgentStore(EntityManagerFactory factory) {
        this.factory = factory;
    }

    /**
     * Opens, creating the database file and schema if absent.
     *
     * <p>The schema is updated rather than validated, because the agent ships as a container
     * image with no migration step of its own: an upgraded image must be able to start against
     * the volume the previous one left behind. The schema here is small and additive, which is
     * what makes that safe.
     *
     * @param databaseFile path to the SQLite file; parent directories are created
     * @param onWarning    receives anything that went wrong without being fatal, such as a mode
     *                     that could not be set on a bind mount this process does not own
     * @return an open store
     * @throws StoreException when the directory cannot be created or the schema cannot be built
     */
    public static AgentStore open(Path databaseFile, Consumer<String> onWarning) throws StoreException {
        Objects.requireNonNull(onWarning, "onWarning");
        Path parent = databaseFile.toAbsolutePath().getParent();
        try {
            if (parent != null) {
                Files.createDirectories(parent);
            }
        } catch (Exception e) {
            throw new StoreException("Could not create the directory for " + databaseFile, e);
        }
        if (parent != null) {
            restrict(parent, DIRECTORY_MODE, onWarning);
        }

        Map<String, Object> settings = new HashMap<>();
        settings.put("jakarta.persistence.jdbc.url",
                "jdbc:sqlite:" + databaseFile.toAbsolutePath() + JOURNAL_MODE_PARAM);
        settings.put("jakarta.persistence.jdbc.driver", "org.sqlite.JDBC");
        settings.put("hibernate.dialect", "org.hibernate.community.dialect.SQLiteDialect");
        settings.put("hibernate.hbm2ddl.auto", "update");
        // Entities are listed explicitly rather than discovered by scanning the classpath.
        // Scanning costs startup time the agent does not have to spare on a Raspberry Pi, and
        // it makes the set of persisted types something you have to go looking for.
        settings.put("hibernate.archive.autodetection", "none");
        settings.put("hibernate.show_sql", false);
        settings.put("hibernate.connection.pool_size", 1);

        AgentStore store;
        try {
            store = new AgentStore(Persistence.createEntityManagerFactory(UNIT_NAME, settings));
        } catch (RuntimeException e) {
            throw new StoreException("Could not open the agent store at " + databaseFile, e);
        }
        // After the factory, because that is what creates the file.
        restrict(databaseFile.toAbsolutePath(), FILE_MODE, onWarning);
        return store;
    }

    /** Opens with warnings discarded, for tests and for callers with nowhere to put them. */
    public static AgentStore open(Path databaseFile) throws StoreException {
        return open(databaseFile, warning -> {
        });
    }

    /**
     * Narrows a path's permissions where the filesystem has them.
     *
     * <p>Best effort by design. The token is held in the clear because the agent has to present
     * it, so the filesystem is what protects it, and this is the code that was missing behind
     * {@code AgentIdentity}'s claim that it already did. A bind mount owned by someone else is an
     * operator's arrangement rather than a fault, and refusing to start over one would be worse
     * for them than the exposure it leaves, so this warns instead.
     */
    private static void restrict(Path path, String mode, Consumer<String> onWarning) {
        if (!path.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            return;
        }
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(mode));
        } catch (IOException | UnsupportedOperationException | SecurityException e) {
            onWarning.accept("Could not restrict " + path + " to " + mode + " (" + e.getMessage()
                    + "). The agent's credential is stored there, so check that no other account "
                    + "on this machine can read it.");
        }
    }

    /**
     * Reads this agent's identity.
     *
     * @return the identity, or empty when the agent has not been paired
     * @throws StoreException when the read fails
     */
    public Optional<AgentIdentity> identity() throws StoreException {
        return read(em -> Optional.ofNullable(em.find(AgentIdentity.class, AgentIdentity.SINGLETON_ID)));
    }

    /**
     * Whether this agent has been paired.
     *
     * @return true once an identity has been stored
     * @throws StoreException when the read fails
     */
    public boolean isPaired() throws StoreException {
        return identity().isPresent();
    }

    /**
     * Stores an identity, replacing any previous one.
     *
     * <p>Replacing rather than refusing is deliberate: re-pairing an agent to a different
     * server, or after the operator unpaired it, is a legitimate operation and the alternative
     * would be telling them to delete a file by hand.
     *
     * @param identity the identity to store
     * @throws StoreException when the write fails
     */
    public void saveIdentity(AgentIdentity identity) throws StoreException {
        write(em -> em.merge(identity));
    }

    /**
     * Removes the stored identity.
     *
     * <p>This is what {@code unpair} does locally. The credential is gone from disk afterwards, so
     * the agent cannot reconnect until it is paired again.
     *
     * <p>Overwritten before it is deleted. SQLite moves a deleted row's page to its freelist
     * without zeroing it, so a plain delete left the token readable in the file with nothing more
     * than {@code strings}, which is not what "forgets this agent's credential" should mean.
     * Overwriting in place only clears it because the store is pinned to a rollback journal (see
     * {@link #JOURNAL_MODE_PARAM}); under write-ahead logging the prior value would survive in the
     * {@code -wal} sibling until a checkpoint.
     *
     * <p>The overwrite and the delete are separate committed transactions, so a failure can land
     * between them: the credential is already dead once the overwrite commits, but its row can
     * still be left behind if the delete then fails. That case is reported as such rather than as
     * an ordinary write failure, since the operator needs to know unpairing has to be retried
     * rather than that it never happened.
     *
     * @return whether an identity was present to remove
     * @throws StoreException when the write fails; if the credential had already been destroyed
     *                         by the time of the failure, the message says so
     */
    public boolean clearIdentity() throws StoreException {
        Optional<AgentIdentity> existing = identity();
        if (existing.isEmpty()) {
            return false;
        }

        byte[] noise = new byte[existing.get().token().length()];
        RANDOM.nextBytes(noise);
        String overwrite = Base64.getUrlEncoder().withoutPadding().encodeToString(noise)
                .substring(0, existing.get().token().length());

        write(em -> em.createQuery("update AgentIdentity set token = :noise where id = :id")
                .setParameter("noise", overwrite)
                .setParameter("id", AgentIdentity.SINGLETON_ID)
                .executeUpdate());

        try {
            write(em -> {
                AgentIdentity row = em.find(AgentIdentity.class, AgentIdentity.SINGLETON_ID);
                if (row != null) {
                    em.remove(row);
                }
            });
        } catch (StoreException e) {
            throw new StoreException("The credential was overwritten and can no longer "
                    + "authenticate, but its row could not be removed. Run unpair again to finish "
                    + "removing it.", e);
        }
        return true;
    }

    /**
     * Runs a read against a fresh entity manager, closing it afterwards.
     *
     * @param work what to read
     * @param <T>  the result type
     * @return the result
     * @throws StoreException when the read fails
     */
    private <T> T read(Function<EntityManager, T> work) throws StoreException {
        try (EntityManager em = factory.createEntityManager()) {
            return work.apply(em);
        } catch (RuntimeException e) {
            throw new StoreException("Agent store read failed", e);
        }
    }

    /**
     * Runs a write in a transaction, rolling back on failure.
     *
     * @param work what to write
     * @throws StoreException when the write fails
     */
    private void write(Consumer<EntityManager> work) throws StoreException {
        try (EntityManager em = factory.createEntityManager()) {
            var transaction = em.getTransaction();
            transaction.begin();
            try {
                work.accept(em);
                transaction.commit();
            } catch (RuntimeException e) {
                // Rolling back explicitly rather than relying on close(): an abandoned open
                // transaction holds a SQLite write lock that the next attempt would block on.
                if (transaction.isActive()) {
                    transaction.rollback();
                }
                throw e;
            }
        } catch (RuntimeException e) {
            throw new StoreException("Agent store write failed", e);
        }
    }

    /** Releases the connection pool. Safe to call more than once. */
    @Override
    public void close() {
        if (factory.isOpen()) {
            factory.close();
        }
    }
}
