/** Minimum CRUD record shape; timestamp names/presence belong to the host model. */
export interface CrudEntity {
  id: string;
  createdAt?: Date;
  updatedAt?: Date;
}
