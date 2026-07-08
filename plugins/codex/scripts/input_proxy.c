#include <unistd.h>
#include <fcntl.h>
#include <termios.h>
#include <signal.h>
#include <stdlib.h>

static int tty_fd = -1;
static pid_t orig_fg = 0;

void cleanup(int sig) {
    /* Restore original foreground group */
    if (tty_fd >= 0 && orig_fg > 0) {
        tcsetpgrp(tty_fd, orig_fg);
    }
    if (tty_fd >= 0) close(tty_fd);
    _exit(0);
}

int main(int argc, char **argv) {
    if (argc < 2) return 1;

    /* Open TTY */
    tty_fd = open(argv[1], O_RDWR);
    if (tty_fd < 0) return 1;

    /* Save original foreground group */
    orig_fg = tcgetpgrp(tty_fd);

    /* New process group */
    setpgid(0, 0);

    /* Become foreground group */
    tcsetpgrp(tty_fd, getpgrp());

    /* Restore on SIGTERM/SIGINT */
    signal(SIGTERM, cleanup);
    signal(SIGINT, cleanup);

    /* Read from TTY, write to stdout (pipe to Node.js) */
    char buf[64];
    for (;;) {
        ssize_t n = read(tty_fd, buf, sizeof(buf));
        if (n <= 0) break;
        if (write(STDOUT_FILENO, buf, n) != n) break;
    }

    cleanup(0);
    return 0;
}
