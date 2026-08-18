package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleManager;
import fi.natroutter.fenpos.console.ConsoleOutput;

import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/** Lists the available commands, or explains one in detail. */
public class HelpCommand implements Command {

    private final ConsoleOutput out;
    private final ConsoleManager console;

    /**
     * @param out     output sink
     * @param console the registry to describe
     */
    public HelpCommand(ConsoleOutput out, ConsoleManager console) {
        this.out = Objects.requireNonNull(out, "out");
        this.console = Objects.requireNonNull(console, "console");
    }

    @Override
    public String name() {
        return "help";
    }

    @Override
    public List<String> aliases() {
        return List.of("?");
    }

    @Override
    public String description() {
        return "List commands, or show detail for one";
    }

    @Override
    public String usage() {
        return "help [command]";
    }

    @Override
    public List<String> complete(String[] args) {
        return args.length == 0
                ? console.commands().stream().map(Command::name).toList()
                : List.of();
    }

    @Override
    public void execute(String[] args) {
        if (args.length > 0) {
            describe(args[0]);
            return;
        }

        int width = console.commands().stream()
                .mapToInt(command -> command.name().length())
                .max()
                .orElse(8);

        out.println("Commands:");
        console.commands().stream()
                .sorted(Comparator.comparing(Command::name))
                .forEach(command -> out.println("  "
                        + pad(command.name(), width) + "  " + command.description()));
        out.println("Type 'help <command>' for usage.");
    }

    private void describe(String name) {
        Optional<Command> command = console.find(name);
        if (command.isEmpty()) {
            out.println("Unknown command '" + name + "'.");
            return;
        }
        Command found = command.get();
        out.println(found.name() + " - " + found.description());
        out.println("  Usage: " + found.usage());
        if (!found.aliases().isEmpty()) {
            out.println("  Aliases: " + String.join(", ", found.aliases()));
        }
    }

    private static String pad(String value, int width) {
        return value + " ".repeat(Math.max(0, width - value.length()));
    }
}
