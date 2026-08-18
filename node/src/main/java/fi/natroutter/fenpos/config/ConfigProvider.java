package fi.natroutter.fenpos.config;

import fi.natroutter.foxlib.files.FileManager;
import fi.natroutter.foxlib.files.ReadResponse;
import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.config.data.ResolvedConfig;

import java.io.File;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Owns {@code config.yaml}: reads it from disk, exports the bundled template on first run,
 * and turns its contents into a {@link ResolvedConfig}.
 * <p>
 * The resolved configuration is replaced wholesale rather than mutated
 * in place. Readers therefore always observe a complete, internally consistent snapshot,
 * which is what makes it safe to share across the HTTP threads, the per-device print
 * workers and the console with no locking beyond the {@code volatile} reference.
 */
public class ConfigProvider {

    private final FileManager fileManager;

    /**
     * Outcome of the most recent read, delivered by {@link FileManager}'s callbacks.
     * Held so a failure can be reported with the reason the file layer gave, rather than
     * flattened into "could not read".
     */
    private final AtomicReference<ReadResponse> lastRead = new AtomicReference<>();

    /**
     * thread; {@code volatile} publishes the fully constructed replacement safely.
     */
    private volatile ResolvedConfig current;

    /**
     * Creates the provider and performs the initial load.
     *
     * @param logger logger used to report file-level problems
     * @throws ConfigurationException if the file is missing, unreadable, malformed, or
     *                                describes a system that cannot be run
     */
    public ConfigProvider(FoxLogger logger) throws ConfigurationException {
        File file = Path.of(System.getProperty("user.dir"), "config.yaml").toFile();
        this.fileManager = new FileManager.Builder(file)
                .setLogger(logger)
                .onInitialized(lastRead::set)
                .onReload(lastRead::set)
                .build();
        this.current = readAndResolve();
    }

    /**
     * Returns the current configuration snapshot.
     *
     * @return the resolved configuration; never {@code null}
     */
    public ResolvedConfig get() {
        return current;
    }

    /**
     * Re-reads and validates {@code config.yaml} without applying it.
     * <p>
     * Deliberately does not replace the running configuration. Applying a change safely
     * means rebuilding the serial handlers and print queues around whatever is in flight —
     * closing ports mid-write, re-homing queued jobs whose device may no longer exist — and
     * a partial version that quietly ignored device changes would be worse than none,
     * because the operator would believe a change had taken effect.
     * <p>
     * Checking the file before restarting is still worth having on its own: it turns a
     * failed restart into a message you can act on while the daemon is still serving.
     *
     * @return the configuration the file would produce
     * @throws ConfigurationException if the file on disk is unusable; the running
     *                                configuration is unaffected either way
     */
    public ResolvedConfig checkOnDisk() throws ConfigurationException {
        fileManager.reload();
        return readAndResolve();
    }

    /**
     * Reads the file and turns it into a resolved configuration.
     *
     * @throws ConfigurationException if the file is unreadable, malformed, or invalid
     */
    private ResolvedConfig readAndResolve() throws ConfigurationException {
        ReadResponse file = lastRead.get();
        if (file == null || !file.success()) {
            String detail = file == null ? "no result from the file layer" : file.message();
            throw new ConfigurationException(List.of(
                    new ConfigProblem("config.yaml", "Could not be read: " + detail)));
        }
        return ConfigResolver.resolve(ConfigParser.parse(file.content()));
    }
}
