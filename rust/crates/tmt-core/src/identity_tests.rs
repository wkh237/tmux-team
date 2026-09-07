use crate::identity::*;

struct ForbiddenRepository;

impl IdentityReader for ForbiddenRepository {
    type Error = std::convert::Infallible;

    fn find_identity(&self, _: &str) -> Result<Option<Identity>, Self::Error> {
        panic!("invalid input must not read storage")
    }

    fn list_identities(&self) -> Result<Vec<Identity>, Self::Error> {
        panic!("invalid input must not list storage")
    }
}

impl IdentityRepository for ForbiddenRepository {
    fn with_identity_transaction<T>(
        &mut self,
        _: impl FnOnce(&mut dyn IdentityWriter<Error = Self::Error>) -> Result<T, Self::Error>,
    ) -> Result<T, Self::Error> {
        panic!("invalid input must not acquire a transaction")
    }
}

#[test]
fn invalid_names_stop_before_repository_access() {
    for name in ["", " ", "a\0b", "%14", "session:1.2"] {
        for lifetime in [Lifetime::Temporary, Lifetime::Saved] {
            assert!(matches!(
                create_or_resolve(&mut ForbiddenRepository, name, lifetime),
                Err(IdentityError::InvalidName(_))
            ));
        }
        assert!(matches!(
            find_by_name(&ForbiddenRepository, name),
            Err(IdentityError::InvalidName(_))
        ));
    }
}
