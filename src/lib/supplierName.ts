import { Supplier } from './api';

// A supplier can be a person, a company, or both (every name field is
// nullable), so a bare `${first_name} ${last_name}` renders blank for a
// company-only supplier. Every screen goes through these two instead.

type SupplierLike = Pick<Supplier, 'first_name' | 'last_name' | 'company_store'>;

export const personName = (s: SupplierLike) => `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim();

// The one name to show: the company when there is one, else the person.
export function supplierTitle(s: SupplierLike | null | undefined): string {
  if (!s) return 'No supplier';
  return (s.company_store ?? '').trim() || personName(s) || 'Unnamed supplier';
}

// For a dropdown, where two suppliers can share a company or a first
// name: "Dangote Depot · Musa Bello", or whichever half exists.
export function supplierOption(s: SupplierLike): string {
  const company = (s.company_store ?? '').trim();
  const person = personName(s);
  if (company && person) return `${company} · ${person}`;
  return company || person || 'Unnamed supplier';
}
