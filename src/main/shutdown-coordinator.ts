export interface ShutdownResources {
  stopPublishing(): void | Promise<void>;
  closeBrowsers(): void | Promise<void>;
  destroyTray(): void;
  closeDatabase(): void;
}

export class ShutdownCoordinator {
  private shutdownTask: Promise<void> | undefined;

  public constructor(private readonly resources: ShutdownResources) {}

  public run(): Promise<void> {
    if (this.shutdownTask !== undefined) return this.shutdownTask;
    this.shutdownTask = this.runOnce();
    return this.shutdownTask;
  }

  private async runOnce(): Promise<void> {
    await this.resources.stopPublishing();
    await this.resources.closeBrowsers();
    this.resources.destroyTray();
    this.resources.closeDatabase();
  }
}
