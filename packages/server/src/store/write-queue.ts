/** Fila que executa escritas uma de cada vez, na ordem em que foram pedidas. */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    // Uma falha não trava a fila: quem chamou recebe o erro pelo `run`.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Resolve quando todas as escritas pedidas até agora terminaram. */
  idle(): Promise<void> {
    return this.tail;
  }
}
