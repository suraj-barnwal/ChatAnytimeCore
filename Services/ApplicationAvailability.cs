namespace ChatAPI.Services
{
    public sealed class ApplicationAvailability
    {
        private int _isAvailable = 1;

        public bool IsAvailable => Volatile.Read(ref _isAvailable) == 1;

        public bool SetAvailable(bool isAvailable) =>
            Interlocked.Exchange(ref _isAvailable, isAvailable ? 1 : 0) == 1;
    }
}
