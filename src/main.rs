mod bs;
mod cli;
mod parser;
mod registry;
mod scanner;

use cli::Cli;

fn main() {
    let cli = Cli::parse_args();
    if let Err(e) = cli.run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
