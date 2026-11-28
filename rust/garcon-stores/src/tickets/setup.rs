use std::path::Path;

use garcon_base::log::{Logger, create_logger};

use super::{
    errors::{Result, ticket_storage_unavailable},
    service::{TicketService, TicketServiceOptions},
    store::{TicketStore, TicketStoreOptions},
};

pub struct TicketRuntime(Option<TicketService>);

impl TicketRuntime {
    pub fn service(&self) -> Result<&TicketService> {
        self.0.as_ref().ok_or_else(ticket_storage_unavailable)
    }

    pub fn close(&self) {
        if let Some(service) = &self.0 {
            service.close();
        }
    }
}

pub fn initialize_tickets(workspace_dir: &Path, options: TicketServiceOptions) -> TicketRuntime {
    match TicketStore::open(workspace_dir, TicketStoreOptions::default()) {
        Ok(store) => TicketRuntime(Some(TicketService::new(store, options))),
        Err(_) => {
            create_logger("tickets")
                .warn("Ticket storage could not open; Tickets remain unavailable until restart.");
            TicketRuntime(None)
        }
    }
}
