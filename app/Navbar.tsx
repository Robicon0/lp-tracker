export default function Navbar() {
  return (
    <nav className="w-full bg-white dark:bg-black border-b border-zinc-200 dark:border-zinc-800">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="text-xl font-bold text-black dark:text-white">
            LP Tracker
          </div>
          <div className="flex gap-6">
            <a href="/" className="text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-white">
              Home
            </a>
            <a href="/dashboard" className="text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-white">
              Dashboard
            </a>
            <a href="/about" className="text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-white">
              About
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}